-- V33 keeps invoice retry ownership durable across preread lease release and
-- provides a bounded compatibility bridge for the rolling backend cutover.

DO $v32_guard$
DECLARE v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v13();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 127
       OR v_preflight.migration_head IS DISTINCT FROM '20260830065627'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v32'
       OR COALESCE(v_preflight.security_failures,ARRAY[]::TEXT[])<>ARRAY[]::TEXT[] THEN
        RAISE EXCEPTION 'Invoice retry V33 requires the exact ready 127/V32 predecessor.';
    END IF;
END;
$v32_guard$;

ALTER TABLE public.billing_provider_operations
    ADD COLUMN invoice_retry_preread_released_at TIMESTAMPTZ,
    ADD COLUMN invoice_retry_preread_release_reason TEXT,
    ADD CONSTRAINT billing_provider_operations_preread_release_marker_v33 CHECK (
        (
            invoice_retry_preread_released_at IS NULL
            AND invoice_retry_preread_release_reason IS NULL
        ) OR (
            operation_type='invoice.retry'
            AND state='started'
            AND provider_request_attempt_count=0
            AND lease_owner IS NULL
            AND lease_acquired_at IS NULL
            AND lease_expires_at IS NULL
            AND invoice_retry_preread_released_at IS NOT NULL
            AND invoice_retry_preread_release_reason IN (
                'provider_preread_failed','provider_preread_unavailable',
                'local_consent_preread_unavailable'
            )
        )
    );

CREATE FUNCTION private.billing_invoice_retry_preread_zero_evidence_v33(
    p_operation public.billing_provider_operations,
    p_marker_mode TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path=''
AS $$
SELECT
    p_marker_mode IN ('absent','present')
    AND p_operation.operation_type='invoice.retry'
    AND p_operation.state='started'
    AND p_operation.provider_request_attempt_count=0
    AND p_operation.provider_object_id IS NULL
    AND p_operation.provider_secondary_object_id IS NULL
    AND p_operation.provider_request_id IS NULL
    AND p_operation.result_code IS NULL
    AND p_operation.result_summary IS NULL
    AND p_operation.error_code IS NULL
    AND p_operation.error_summary IS NULL
    AND p_operation.reconciliation_reason_code IS NULL
    AND p_operation.reconciliation_required_at IS NULL
    AND p_operation.recovery_proof_sha256 IS NULL
    AND p_operation.recovery_outcome IS NULL
    AND p_operation.recovery_actor_id IS NULL
    AND p_operation.recovery_authorized_at IS NULL
    AND p_operation.provider_request_in_flight_at IS NULL
    AND p_operation.provider_succeeded_at IS NULL
    AND p_operation.projected_at IS NULL
    AND p_operation.completed_at IS NULL
    AND p_operation.definitive_failed_at IS NULL
    AND p_operation.definitive_rejected_at IS NULL
    AND p_operation.provider_step_plan_sha256 IS NULL
    AND p_operation.provider_step_expected_count IS NULL
    AND p_operation.provider_step_plan_registered_at IS NULL
    AND (
      (p_marker_mode='absent'
       AND p_operation.invoice_retry_preread_released_at IS NULL
       AND p_operation.invoice_retry_preread_release_reason IS NULL)
      OR
      (p_marker_mode='present'
       AND p_operation.lease_owner IS NULL
       AND p_operation.lease_acquired_at IS NULL
       AND p_operation.lease_expires_at IS NULL
       AND p_operation.invoice_retry_preread_released_at IS NOT NULL
       AND p_operation.invoice_retry_preread_release_reason IN(
        'provider_preread_failed','provider_preread_unavailable',
        'local_consent_preread_unavailable'))
    )
    AND NOT EXISTS(
      SELECT 1 FROM public.billing_provider_operation_steps AS step
      WHERE step.operation_id=p_operation.id AND (
        step.state<>'pending'
        OR step.provider_request_attempt_count<>0
        OR step.provider_object_id IS NOT NULL
        OR step.provider_secondary_object_id IS NOT NULL
        OR step.provider_request_id IS NOT NULL
        OR step.result_code IS NOT NULL
        OR to_jsonb(step)->>'result_summary' IS NOT NULL
        OR step.error_code IS NOT NULL
        OR to_jsonb(step)->>'error_summary' IS NOT NULL
        OR step.reconciliation_reason_code IS NOT NULL
        OR step.reconciliation_required_at IS NOT NULL
        OR step.recovery_proof_sha256 IS NOT NULL
        OR step.recovery_outcome IS NOT NULL
        OR step.recovery_actor_id IS NOT NULL
        OR step.recovery_authorized_at IS NOT NULL
        OR step.provider_request_in_flight_at IS NOT NULL
        OR step.provider_succeeded_at IS NOT NULL
        OR step.definitive_failed_at IS NOT NULL
        OR step.definitive_rejected_at IS NOT NULL
      )
    );
$$;
ALTER FUNCTION private.billing_invoice_retry_preread_zero_evidence_v33(
 public.billing_provider_operations,TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_invoice_retry_preread_zero_evidence_v33(
 public.billing_provider_operations,TEXT) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.billing_invoice_retry_base_hash_v33(
    p_studio_id UUID,
    p_invoice_id UUID,
    p_stripe_invoice_id TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE v_canonical TEXT;
BEGIN
    IF p_stripe_invoice_id='' OR p_stripe_connected_account_id=''
       OR p_connect_account_generation<=0
       OR p_stripe_invoice_id~'[^ -~]'
       OR p_stripe_connected_account_id~'[^ -~]' THEN
        RAISE EXCEPTION USING ERRCODE='22023',
            MESSAGE='billing_invoice_retry_base_hash_input_invalid';
    END IF;
    v_canonical :=
        '{"connect_account_generation":'||p_connect_account_generation::TEXT||
        ',"invoice_id":'||to_json(p_invoice_id::TEXT)::TEXT||
        ',"operation_type":"invoice.retry"'||
        ',"stripe_connected_account_id":'||to_json(p_stripe_connected_account_id)::TEXT||
        ',"stripe_invoice_id":'||to_json(p_stripe_invoice_id)::TEXT||
        ',"studio_id":'||to_json(p_studio_id::TEXT)::TEXT||'}';
    RETURN encode(extensions.digest(convert_to(v_canonical,'UTF8'),'sha256'),'hex');
END;
$$;
ALTER FUNCTION private.billing_invoice_retry_base_hash_v33(UUID,UUID,TEXT,TEXT,INTEGER)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.billing_invoice_retry_base_hash_v33(UUID,UUID,TEXT,TEXT,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.resolve_billing_invoice_retry_identity_v33(
    p_operation_id UUID,p_studio_id UUID,p_invoice_id UUID,p_payer_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
 v_operation public.billing_provider_operations%ROWTYPE;
 v_invoice public.billing_invoices%ROWTYPE;
 v_payer public.billing_payers%ROWTYPE;
 v_account public.studio_payment_accounts%ROWTYPE;
 v_invoice_generation INTEGER;
 v_current_generation INTEGER;
 v_generation_text TEXT;
 v_base TEXT;
BEGIN
 SELECT * INTO v_payer FROM public.billing_payers
 WHERE id=p_payer_id AND studio_id=p_studio_id FOR UPDATE;
 SELECT * INTO v_account FROM public.studio_payment_accounts
 WHERE studio_id=p_studio_id FOR UPDATE;
 SELECT * INTO v_invoice FROM public.billing_invoices
 WHERE id=p_invoice_id AND studio_id=p_studio_id FOR UPDATE;
 SELECT * INTO v_operation FROM public.billing_provider_operations
 WHERE id=p_operation_id FOR UPDATE;
 IF v_payer.id IS NULL OR v_account.studio_id IS NULL OR v_invoice.id IS NULL
    OR (p_operation_id IS NOT NULL AND (
      v_operation.id IS NULL OR v_operation.operation_type<>'invoice.retry'
      OR v_operation.studio_id IS DISTINCT FROM p_studio_id
      OR v_operation.stripe_connected_account_id IS DISTINCT FROM v_payer.stripe_account_id
      OR v_operation.connect_account_generation
           IS DISTINCT FROM v_payer.connect_account_generation))
    OR v_invoice.studio_id IS DISTINCT FROM p_studio_id
    OR v_invoice.payer_id IS DISTINCT FROM p_payer_id
    OR v_payer.studio_id IS DISTINCT FROM p_studio_id
    OR v_payer.stripe_account_id IS NULL OR btrim(v_payer.stripe_account_id)=''
    OR v_payer.stripe_customer_id IS NULL OR btrim(v_payer.stripe_customer_id)=''
    OR v_payer.connect_account_generation IS NULL
    OR v_payer.connect_account_generation<=0
    OR v_invoice.stripe_invoice_id IS NULL OR btrim(v_invoice.stripe_invoice_id)=''
    OR v_invoice.stripe_account_id IS DISTINCT FROM v_payer.stripe_account_id
    OR v_invoice.stripe_customer_id IS DISTINCT FROM v_payer.stripe_customer_id
    OR v_account.stripe_connected_account_id IS DISTINCT FROM v_payer.stripe_account_id THEN
   RAISE EXCEPTION USING ERRCODE='23514',
    MESSAGE='billing_invoice_retry_identity_resolution_failed';
 END IF;
 v_current_generation:=private.current_connect_account_generation(v_account.metadata);
 IF v_current_generation IS NULL OR v_current_generation<=0
    OR v_current_generation IS DISTINCT FROM v_payer.connect_account_generation THEN
   RAISE EXCEPTION USING ERRCODE='23514',
    MESSAGE='billing_invoice_retry_identity_resolution_failed';
 END IF;
 IF v_invoice.metadata?'connect_account_generation' THEN
   IF jsonb_typeof(v_invoice.metadata->'connect_account_generation')<>'number' THEN
     RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='billing_invoice_retry_identity_resolution_failed';
   END IF;
   v_generation_text:=v_invoice.metadata->>'connect_account_generation';
   IF v_generation_text IS NULL OR v_generation_text!~'^[1-9][0-9]{0,9}$'
      OR length(v_generation_text)>10
      OR v_generation_text::NUMERIC>2147483647 THEN
     RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE='billing_invoice_retry_identity_resolution_failed';
   END IF;
   v_invoice_generation:=v_generation_text::INTEGER;
 ELSE
   v_invoice_generation:=v_payer.connect_account_generation;
 END IF;
 IF v_invoice_generation IS DISTINCT FROM v_payer.connect_account_generation THEN
   RAISE EXCEPTION USING ERRCODE='23514',
    MESSAGE='billing_invoice_retry_identity_resolution_failed';
 END IF;
 v_base:=private.billing_invoice_retry_base_hash_v33(
  p_studio_id,p_invoice_id,v_invoice.stripe_invoice_id,
  v_payer.stripe_account_id,v_invoice_generation);
 RETURN jsonb_build_object(
  'base_request_sha256',v_base,'stripe_invoice_id',v_invoice.stripe_invoice_id,
  'stripe_connected_account_id',v_payer.stripe_account_id,
  'stripe_customer_id',v_payer.stripe_customer_id,
  'connect_account_generation',v_invoice_generation);
END;
$$;
ALTER FUNCTION private.resolve_billing_invoice_retry_identity_v33(UUID,UUID,UUID,UUID)
 OWNER TO postgres;
REVOKE ALL ON FUNCTION private.resolve_billing_invoice_retry_identity_v33(UUID,UUID,UUID,UUID)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE private.billing_invoice_retry_hash_capture_control_v33(
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
    capture_enabled BOOLEAN NOT NULL DEFAULT true,
    revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
    finalized_candidate_sha TEXT,
    finalized_proof_sha256 TEXT,
    finalized_at TIMESTAMPTZ,
    CONSTRAINT billing_invoice_retry_hash_capture_final_v33 CHECK (
        (capture_enabled AND finalized_candidate_sha IS NULL
            AND finalized_proof_sha256 IS NULL AND finalized_at IS NULL)
        OR (NOT capture_enabled
            AND finalized_candidate_sha~'^[0-9a-f]{40}$'
            AND finalized_proof_sha256~'^[0-9a-f]{64}$'
            AND finalized_at IS NOT NULL)
    )
);
ALTER TABLE private.billing_invoice_retry_hash_capture_control_v33 OWNER TO postgres;
ALTER TABLE private.billing_invoice_retry_hash_capture_control_v33 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.billing_invoice_retry_hash_capture_control_v33
    FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.billing_invoice_retry_hash_capture_control_v33(singleton) VALUES(true);

CREATE TABLE private.billing_invoice_retry_hash_ledger_v33(
    operation_id UUID NOT NULL,
    resource_claim_id UUID NOT NULL,
    studio_id UUID NOT NULL,
    invoice_id UUID NOT NULL,
    payer_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    operation_caller_request_key TEXT NOT NULL,
    caller_request_key TEXT NOT NULL,
    stripe_connected_account_id TEXT NOT NULL,
    connect_account_generation INTEGER NOT NULL CHECK(connect_account_generation>0),
    stripe_invoice_id TEXT NOT NULL,
    persisted_request_sha256 TEXT NOT NULL CHECK(persisted_request_sha256~'^[0-9a-f]{64}$'),
    base_request_sha256 TEXT NOT NULL CHECK(base_request_sha256~'^[0-9a-f]{64}$'),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(operation_id,caller_request_key),
    UNIQUE(studio_id,caller_request_key)
);
ALTER TABLE private.billing_invoice_retry_hash_ledger_v33 OWNER TO postgres;
ALTER TABLE private.billing_invoice_retry_hash_ledger_v33 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.billing_invoice_retry_hash_ledger_v33
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.preserve_billing_invoice_retry_hash_ledger_v33()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='23514',
        MESSAGE='billing_invoice_retry_hash_ledger_immutable';
END;
$$;
ALTER FUNCTION private.preserve_billing_invoice_retry_hash_ledger_v33() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.preserve_billing_invoice_retry_hash_ledger_v33()
    FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER preserve_billing_invoice_retry_hash_ledger_v33
    BEFORE UPDATE OR DELETE ON private.billing_invoice_retry_hash_ledger_v33
    FOR EACH ROW EXECUTE FUNCTION private.preserve_billing_invoice_retry_hash_ledger_v33();

CREATE FUNCTION private.capture_billing_invoice_retry_hash_v33(
    p_operation_id UUID,p_resource_claim_id UUID,p_studio_id UUID,
    p_invoice_id UUID,p_payer_id UUID,p_caller_request_key TEXT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_enabled BOOLEAN;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_resource public.billing_provider_operation_resources%ROWTYPE;
    v_invoice public.billing_invoices%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_existing private.billing_invoice_retry_hash_ledger_v33%ROWTYPE;
    v_base TEXT;
    v_identity JSONB;
BEGIN
    SELECT capture_enabled INTO v_enabled
    FROM private.billing_invoice_retry_hash_capture_control_v33
    WHERE singleton FOR SHARE;
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id=p_operation_id FOR UPDATE;
    SELECT * INTO v_resource FROM public.billing_provider_operation_resources
    WHERE id=p_resource_claim_id FOR UPDATE;
    SELECT * INTO v_invoice FROM public.billing_invoices
    WHERE id=p_invoice_id AND studio_id=p_studio_id FOR SHARE;
    IF v_operation.id IS NULL OR v_resource.id IS NULL OR v_invoice.id IS NULL
       OR v_operation.operation_type<>'invoice.retry'
       OR v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_resource.operation_id IS DISTINCT FROM p_operation_id
       OR v_resource.studio_id IS DISTINCT FROM p_studio_id
       OR v_resource.operation_type<>'invoice.retry'
       OR v_resource.resource_type<>'invoice'
       OR v_resource.resource_id IS DISTINCT FROM p_invoice_id
       OR v_resource.payer_id IS DISTINCT FROM p_payer_id
       OR v_invoice.payer_id IS DISTINCT FROM p_payer_id
       OR v_invoice.stripe_invoice_id IS NULL
       OR v_operation.stripe_connected_account_id
            IS DISTINCT FROM v_invoice.stripe_account_id THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_retry_hash_capture_binding_invalid';
    END IF;
    v_identity:=private.resolve_billing_invoice_retry_identity_v33(
        p_operation_id,p_studio_id,p_invoice_id,p_payer_id);
    v_base:=v_identity->>'base_request_sha256';
    SELECT * INTO v_existing FROM private.billing_invoice_retry_hash_ledger_v33
    WHERE operation_id=p_operation_id AND caller_request_key=p_caller_request_key
    FOR UPDATE;
    IF FOUND THEN
        IF (v_existing.resource_claim_id,v_existing.studio_id,v_existing.invoice_id,
            v_existing.payer_id,v_existing.actor_id,
            v_existing.operation_caller_request_key,v_existing.caller_request_key,
            v_existing.stripe_connected_account_id,v_existing.connect_account_generation,
            v_existing.stripe_invoice_id,v_existing.persisted_request_sha256,
            v_existing.base_request_sha256)
           IS DISTINCT FROM
           (p_resource_claim_id,p_studio_id,p_invoice_id,p_payer_id,
            v_operation.actor_id,v_operation.caller_request_key,p_caller_request_key,
            v_operation.stripe_connected_account_id,
            v_operation.connect_account_generation,v_invoice.stripe_invoice_id,
            v_operation.request_sha256,v_base) THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_retry_hash_capture_conflict';
        END IF;
        RETURN;
    END IF;
    IF NOT v_enabled THEN
        IF v_operation.request_sha256 IS DISTINCT FROM v_base THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_retry_hash_capture_disabled_mismatch';
        END IF;
        RETURN;
    END IF;
    INSERT INTO private.billing_invoice_retry_hash_ledger_v33(
        operation_id,resource_claim_id,studio_id,invoice_id,payer_id,actor_id,
        operation_caller_request_key,
        caller_request_key,stripe_connected_account_id,connect_account_generation,
        stripe_invoice_id,persisted_request_sha256,base_request_sha256
    ) VALUES(
        p_operation_id,p_resource_claim_id,p_studio_id,p_invoice_id,p_payer_id,
        v_operation.actor_id,v_operation.caller_request_key,p_caller_request_key,
        v_operation.stripe_connected_account_id,
        v_operation.connect_account_generation,v_invoice.stripe_invoice_id,
        v_operation.request_sha256,v_base
    );
END;
$$;
ALTER FUNCTION private.capture_billing_invoice_retry_hash_v33(UUID,UUID,UUID,UUID,UUID,TEXT)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.capture_billing_invoice_retry_hash_v33(UUID,UUID,UUID,UUID,UUID,TEXT)
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.capture_billing_invoice_retry_resource_v33()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key TEXT;
BEGIN
    IF NEW.operation_type<>'invoice.retry' OR NEW.resource_type<>'invoice' THEN
        RETURN NEW;
    END IF;
    SELECT caller_request_key INTO v_key FROM public.billing_provider_operations
    WHERE id=NEW.operation_id;
    PERFORM private.capture_billing_invoice_retry_hash_v33(
        NEW.operation_id,NEW.id,NEW.studio_id,NEW.resource_id,NEW.payer_id,v_key
    );
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.capture_billing_invoice_retry_resource_v33() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.capture_billing_invoice_retry_resource_v33()
    FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER capture_billing_invoice_retry_resource_v33
    AFTER INSERT OR UPDATE OF operation_id
    ON public.billing_provider_operation_resources
    FOR EACH ROW EXECUTE FUNCTION private.capture_billing_invoice_retry_resource_v33();

CREATE FUNCTION private.capture_billing_invoice_retry_alias_v33()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NEW.operation_type='invoice.retry' AND NEW.resource_type='invoice' THEN
        PERFORM private.capture_billing_invoice_retry_hash_v33(
            NEW.operation_id,NEW.resource_claim_id,NEW.studio_id,
            NEW.resource_id,NEW.payer_id,NEW.caller_request_key
        );
    END IF;
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.capture_billing_invoice_retry_alias_v33() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.capture_billing_invoice_retry_alias_v33()
    FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER capture_billing_invoice_retry_alias_v33
    AFTER INSERT ON public.billing_provider_operation_resource_aliases
    FOR EACH ROW EXECUTE FUNCTION private.capture_billing_invoice_retry_alias_v33();

DO $backfill_v33$
DECLARE v_alias RECORD;
BEGIN
    LOCK TABLE public.billing_provider_operation_resources IN SHARE ROW EXCLUSIVE MODE;
    LOCK TABLE public.billing_provider_operation_resource_aliases IN SHARE ROW EXCLUSIVE MODE;
    FOR v_alias IN
        SELECT alias.operation_id,alias.resource_claim_id,alias.studio_id,
               alias.resource_id,alias.payer_id,alias.caller_request_key
        FROM public.billing_provider_operation_resource_aliases AS alias
        WHERE alias.operation_type='invoice.retry' AND alias.resource_type='invoice'
        ORDER BY alias.operation_id,alias.caller_request_key
    LOOP
        PERFORM private.capture_billing_invoice_retry_hash_v33(
            v_alias.operation_id,v_alias.resource_claim_id,v_alias.studio_id,
            v_alias.resource_id,v_alias.payer_id,v_alias.caller_request_key
        );
    END LOOP;
END;
$backfill_v33$;

CREATE FUNCTION public.release_billing_invoice_retry_preread_lease_v33(
    p_operation_id UUID,p_studio_id UUID,p_actor_id UUID,
    p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_expected_revision BIGINT,p_release_reason TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_invoice public.billing_invoices%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_owner public.billing_invoice_mutation_owners%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_resource public.billing_provider_operation_resources%ROWTYPE;
    v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    SELECT invoice.* INTO v_invoice
    FROM public.billing_invoice_mutation_owners AS owner
    JOIN public.billing_invoices AS invoice
      ON invoice.id=owner.invoice_id AND invoice.studio_id=owner.studio_id
    WHERE owner.operation_id=p_operation_id AND owner.studio_id=p_studio_id
    FOR UPDATE OF invoice;
    IF v_invoice.id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_retry_preread_release_v33_identity_mismatch';
    END IF;
    SELECT * INTO v_payer FROM public.billing_payers
    WHERE id=v_invoice.payer_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_owner FROM public.billing_invoice_mutation_owners
    WHERE studio_id=p_studio_id AND invoice_id=v_invoice.id FOR UPDATE;
    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id=p_operation_id FOR UPDATE;
    SELECT * INTO v_resource FROM public.billing_provider_operation_resources
    WHERE id=v_owner.resource_claim_id FOR UPDATE;
    IF v_operation.id IS NULL OR v_payer.id IS NULL OR v_resource.id IS NULL
       OR v_owner.studio_id IS DISTINCT FROM p_studio_id
       OR v_owner.invoice_id IS DISTINCT FROM v_invoice.id
       OR v_owner.payer_id IS DISTINCT FROM v_invoice.payer_id
       OR v_owner.operation_id IS DISTINCT FROM p_operation_id
       OR v_owner.resource_claim_id IS DISTINCT FROM v_resource.id
       OR v_owner.operation_type<>'invoice.retry'
       OR v_owner.resource_type<>'invoice'
       OR v_resource.operation_id IS DISTINCT FROM p_operation_id
       OR v_resource.studio_id IS DISTINCT FROM p_studio_id
       OR v_resource.operation_type<>'invoice.retry'
       OR v_resource.resource_type<>'invoice'
       OR v_resource.resource_id IS DISTINCT FROM v_invoice.id
       OR v_resource.payer_id IS DISTINCT FROM v_invoice.payer_id
       OR v_payer.id IS DISTINCT FROM v_invoice.payer_id
       OR v_payer.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.operation_type<>'invoice.retry'
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id
            IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation
            IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_retry_preread_release_v33_identity_mismatch';
    END IF;
    PERFORM private.resolve_billing_invoice_retry_identity_v33(
      p_operation_id,p_studio_id,v_invoice.id,v_invoice.payer_id);
    IF v_operation.revision IS DISTINCT FROM p_expected_revision THEN
        RAISE EXCEPTION USING ERRCODE='40001',
            MESSAGE='billing_invoice_retry_preread_release_v33_stale_revision';
    END IF;
    IF p_release_reason NOT IN (
        'provider_preread_failed','provider_preread_unavailable',
        'local_consent_preread_unavailable'
    ) THEN
        RAISE EXCEPTION USING ERRCODE='22023',
            MESSAGE='billing_invoice_retry_preread_release_v33_reason_invalid';
    END IF;
    IF v_operation.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_operation.lease_owner IS NULL
       OR v_operation.lease_acquired_at IS NULL
       OR v_operation.lease_acquired_at>v_now
       OR v_operation.lease_expires_at IS NULL
       OR v_operation.lease_expires_at<=v_now THEN
        RAISE EXCEPTION USING ERRCODE='55000',
            MESSAGE='billing_invoice_retry_preread_release_v33_lease_not_current';
    END IF;
    IF NOT private.billing_invoice_retry_preread_zero_evidence_v33(
        v_operation,'absent') THEN
        RAISE EXCEPTION USING ERRCODE='55000',
            MESSAGE='billing_invoice_retry_preread_release_v33_mutation_evidence';
    END IF;
    UPDATE public.billing_provider_operations SET
        lease_owner=NULL,lease_acquired_at=NULL,lease_expires_at=NULL,
        invoice_retry_preread_released_at=v_now,
        invoice_retry_preread_release_reason=p_release_reason,
        revision=revision+1,updated_at=v_now
    WHERE id=p_operation_id RETURNING * INTO v_operation;
    RETURN jsonb_build_object('outcome','released','operation',to_jsonb(v_operation));
END;
$$;
ALTER FUNCTION public.release_billing_invoice_retry_preread_lease_v33(
    UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT,TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_billing_invoice_retry_preread_lease_v33(
    UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT,TEXT)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v33(
    UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT,TEXT) TO service_role;

CREATE FUNCTION private.claim_billing_invoice_retry_v33(
    p_studio_id UUID,p_actor_id UUID,p_resource_id UUID,p_payer_id UUID,
    p_caller_request_key TEXT,p_requested_base_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_invoice public.billing_invoices%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_owner public.billing_invoice_mutation_owners%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_ledger private.billing_invoice_retry_hash_ledger_v33%ROWTYPE;
    v_ledger_operation public.billing_provider_operations%ROWTYPE;
    v_ledger_resource public.billing_provider_operation_resources%ROWTYPE;
    v_ledger_alias public.billing_provider_operation_resource_aliases%ROWTYPE;
    v_base TEXT;
    v_persisted TEXT;
    v_result JSONB;
    v_outcome TEXT:='base_hash_exact';
    v_capture_enabled BOOLEAN;
    v_identity JSONB;
    v_has_ledger BOOLEAN;
    v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.staff_roles
      WHERE studio_id=p_studio_id AND user_id=p_actor_id
        AND archived_at IS NULL AND role='admin') THEN
        RAISE EXCEPTION USING ERRCODE='42501',
            MESSAGE='billing_invoice_mutation_actor_forbidden';
    END IF;
    SELECT * INTO v_invoice FROM public.billing_invoices
    WHERE id=p_resource_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_payer FROM public.billing_payers
    WHERE id=p_payer_id AND studio_id=p_studio_id FOR UPDATE;
    SELECT * INTO v_owner FROM public.billing_invoice_mutation_owners
    WHERE studio_id=p_studio_id AND invoice_id=p_resource_id FOR UPDATE;
    IF v_owner.operation_id IS NOT NULL THEN
        SELECT * INTO v_operation FROM public.billing_provider_operations
        WHERE id=v_owner.operation_id FOR UPDATE;
    END IF;
    IF v_invoice.id IS NULL OR v_invoice.payer_id IS DISTINCT FROM p_payer_id
       OR v_invoice.stripe_invoice_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_invoice_mutation_identity_mismatch';
    END IF;
    SELECT capture_enabled INTO v_capture_enabled
    FROM private.billing_invoice_retry_hash_capture_control_v33
    WHERE singleton FOR SHARE;
    SELECT * INTO v_ledger FROM private.billing_invoice_retry_hash_ledger_v33
    WHERE studio_id=p_studio_id AND caller_request_key=p_caller_request_key
    FOR SHARE;
    v_has_ledger:=FOUND;
    v_identity:=private.resolve_billing_invoice_retry_identity_v33(
      CASE WHEN v_has_ledger THEN v_ledger.operation_id
           WHEN v_owner.operation_type='invoice.retry' THEN v_owner.operation_id
           ELSE NULL END,
      p_studio_id,p_resource_id,p_payer_id);
    v_base:=v_identity->>'base_request_sha256';
    IF v_has_ledger THEN
        SELECT * INTO v_ledger_operation FROM public.billing_provider_operations
        WHERE id=v_ledger.operation_id;
        SELECT * INTO v_ledger_resource FROM public.billing_provider_operation_resources
        WHERE id=v_ledger.resource_claim_id;
        SELECT * INTO v_ledger_alias
        FROM public.billing_provider_operation_resource_aliases
        WHERE operation_id=v_ledger.operation_id
          AND caller_request_key=p_caller_request_key;
        IF p_requested_base_sha256 IS DISTINCT FROM v_base
           AND NOT (v_capture_enabled AND p_requested_base_sha256
                IS NOT DISTINCT FROM v_ledger.persisted_request_sha256) THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_retry_v33_base_hash_mismatch';
        END IF;
        IF v_ledger.stripe_connected_account_id
              IS DISTINCT FROM p_stripe_connected_account_id
           OR v_ledger.connect_account_generation
              IS DISTINCT FROM p_connect_account_generation THEN
            RAISE EXCEPTION USING ERRCODE='23505',
              MESSAGE='billing_provider_operation_resource_request_conflict';
        END IF;
        IF v_ledger.invoice_id IS DISTINCT FROM p_resource_id
           OR v_ledger.payer_id IS DISTINCT FROM p_payer_id
           OR v_ledger.actor_id IS DISTINCT FROM p_actor_id
           OR v_ledger_operation.operation_type<>'invoice.retry'
           OR v_ledger_operation.caller_request_key
                IS DISTINCT FROM v_ledger.operation_caller_request_key
           OR v_ledger_operation.stripe_connected_account_id
                IS DISTINCT FROM v_ledger.stripe_connected_account_id
           OR v_ledger_operation.connect_account_generation
                IS DISTINCT FROM v_ledger.connect_account_generation
           OR v_ledger.stripe_invoice_id IS DISTINCT FROM v_invoice.stripe_invoice_id
           OR v_invoice.studio_id IS DISTINCT FROM v_ledger.studio_id
           OR v_invoice.payer_id IS DISTINCT FROM v_ledger.payer_id
           OR v_invoice.stripe_account_id
                IS DISTINCT FROM v_ledger.stripe_connected_account_id
           OR COALESCE((CASE WHEN v_invoice.metadata?'connect_account_generation'
                THEN (v_invoice.metadata->>'connect_account_generation')::INTEGER
                ELSE NULL END),v_payer.connect_account_generation)
                IS DISTINCT FROM v_ledger.connect_account_generation
           OR v_ledger.base_request_sha256 IS DISTINCT FROM v_base
           OR v_ledger_operation.id IS DISTINCT FROM v_ledger.operation_id
           OR v_ledger_operation.studio_id IS DISTINCT FROM p_studio_id
           OR v_ledger_operation.actor_id IS DISTINCT FROM p_actor_id
           OR v_ledger_operation.request_sha256
                IS DISTINCT FROM v_ledger.persisted_request_sha256 THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_retry_v33_ledger_binding_mismatch';
        END IF;
        IF v_ledger_resource.id IS NULL
           OR v_ledger_resource.studio_id IS DISTINCT FROM v_ledger.studio_id
           OR v_ledger_resource.operation_type<>'invoice.retry'
           OR v_ledger_resource.resource_type<>'invoice'
           OR v_ledger_resource.resource_id IS DISTINCT FROM p_resource_id
           OR v_ledger_resource.payer_id IS DISTINCT FROM p_payer_id
           OR v_ledger_alias.id IS NULL
           OR v_ledger_alias.operation_id IS DISTINCT FROM v_ledger.operation_id
           OR v_ledger_alias.resource_claim_id IS DISTINCT FROM v_ledger.resource_claim_id
           OR v_ledger_alias.studio_id IS DISTINCT FROM v_ledger.studio_id
           OR v_ledger_alias.operation_type<>'invoice.retry'
           OR v_ledger_alias.resource_type<>'invoice'
           OR v_ledger_alias.resource_id IS DISTINCT FROM p_resource_id
           OR v_ledger_alias.payer_id IS DISTINCT FROM p_payer_id
           OR v_ledger_alias.caller_request_key
                IS DISTINCT FROM v_ledger.caller_request_key THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_retry_v33_ledger_binding_mismatch';
        END IF;
        v_persisted:=v_ledger.persisted_request_sha256;
        v_outcome:=CASE
            WHEN p_requested_base_sha256=v_base AND v_persisted=v_base
              THEN 'ledger_base_hash_exact'
            WHEN p_requested_base_sha256=v_base
              THEN 'ledger_legacy_hash_accepted'
            ELSE 'ledger_legacy_hash_replay' END;
        IF v_ledger_operation.state NOT IN(
            'completed','definitive_failed','definitive_rejected'
        ) AND (
            v_ledger_resource.operation_id IS DISTINCT FROM v_ledger.operation_id
            OR
            v_owner.operation_id IS DISTINCT FROM v_ledger.operation_id
            OR v_owner.resource_claim_id IS DISTINCT FROM v_ledger.resource_claim_id
            OR v_owner.operation_type<>'invoice.retry'
            OR v_owner.resource_type<>'invoice'
        ) THEN
            RAISE EXCEPTION USING ERRCODE='55P03',
                MESSAGE='billing_invoice_retry_v33_current_owner_mismatch';
        END IF;
        IF v_ledger_operation.state IN(
            'completed','definitive_failed','definitive_rejected'
        ) AND v_ledger_resource.operation_id IS DISTINCT FROM v_ledger.operation_id
          AND (
            v_owner.operation_id IS NULL
            OR v_owner.operation_id IS DISTINCT FROM v_ledger_resource.operation_id
            OR v_owner.resource_claim_id IS DISTINCT FROM v_ledger.resource_claim_id
            OR v_owner.operation_type<>'invoice.retry'
            OR v_owner.resource_type<>'invoice'
            OR v_operation.id IS DISTINCT FROM v_owner.operation_id
            OR v_operation.studio_id IS DISTINCT FROM v_ledger.studio_id
            OR v_operation.operation_type<>'invoice.retry'
            OR v_operation.stripe_connected_account_id
                 IS DISTINCT FROM v_ledger.stripe_connected_account_id
            OR v_operation.connect_account_generation
                 IS DISTINCT FROM v_ledger.connect_account_generation
          ) THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_retry_v33_terminal_replacement_invalid';
        END IF;
    ELSE
        IF NOT v_capture_enabled
           AND p_requested_base_sha256 IS DISTINCT FROM v_base THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_retry_v33_base_hash_mismatch';
        END IF;
        v_persisted:=p_requested_base_sha256;
        v_outcome:=CASE WHEN v_persisted=v_base THEN 'base_hash_exact'
            ELSE 'capture_legacy_hash_created' END;
    END IF;
    IF v_operation.invoice_retry_preread_released_at IS NOT NULL THEN
        UPDATE public.billing_provider_operations SET
            invoice_retry_preread_released_at=NULL,
            invoice_retry_preread_release_reason=NULL,
            revision=revision+1,updated_at=v_now
        WHERE id=v_operation.id;
    END IF;
    v_result:=private.claim_billing_invoice_mutation_v31(
        p_studio_id,p_actor_id,'invoice.retry','invoice',p_resource_id,p_payer_id,
        p_caller_request_key,v_persisted,p_stripe_connected_account_id,
        p_connect_account_generation,p_lease_owner,p_lease_seconds
    );
    IF v_operation.invoice_retry_preread_released_at IS NOT NULL THEN
        SELECT private.billing_provider_operation_resource_json_v1(
            resource,operation,p_caller_request_key,'reclaimed'
        ) INTO v_result
        FROM public.billing_provider_operation_resources AS resource
        JOIN public.billing_provider_operations AS operation
          ON operation.id=resource.operation_id
        WHERE operation.id=v_owner.operation_id;
    END IF;
    RETURN v_result||jsonb_build_object(
        'compatibility_outcome',v_outcome,
        'requested_base_sha256',v_base,
        'effective_persisted_sha256',v_persisted
    );
END;
$$;
ALTER FUNCTION private.claim_billing_invoice_retry_v33(
    UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.claim_billing_invoice_retry_v33(
    UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.claim_billing_provider_operation_resource_v1(
    p_studio_id UUID,p_actor_id UUID,p_operation_type TEXT,p_resource_type TEXT,
    p_resource_id UUID,p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $wrapper$
BEGIN
    IF (p_operation_type,p_resource_type)=('invoice.retry','invoice') THEN
        RETURN private.claim_billing_invoice_retry_v33(
            p_studio_id,p_actor_id,p_resource_id,p_payer_id,p_caller_request_key,
            p_request_sha256,p_stripe_connected_account_id,
            p_connect_account_generation,p_lease_owner,p_lease_seconds);
    END IF;
    IF (p_operation_type,p_resource_type) IN (
        ('payment.refund','payment'),('payer.sync','payer'),('plan.sync','plan')) THEN
        RETURN private.claim_payment_payer_operation_resource_v31(
            p_studio_id,p_actor_id,p_operation_type,p_resource_type,p_resource_id,
            p_payer_id,p_caller_request_key,p_request_sha256,
            p_stripe_connected_account_id,p_connect_account_generation,
            p_lease_owner,p_lease_seconds);
    END IF;
    RETURN public.claim_billing_provider_operation_resource_v30(
        p_studio_id,p_actor_id,p_operation_type,p_resource_type,p_resource_id,
        p_payer_id,p_caller_request_key,p_request_sha256,
        p_stripe_connected_account_id,p_connect_account_generation,
        p_lease_owner,p_lease_seconds);
END;
$wrapper$;
ALTER FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_provider_operation_resource_v1(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER) TO service_role;

CREATE FUNCTION private.handle_invoice_retry_consent_change_v33(
    p_studio_id UUID,p_payer_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_owner public.billing_invoice_mutation_owners%ROWTYPE;
        v_operation public.billing_provider_operations%ROWTYPE;
        v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    PERFORM 1 FROM public.billing_payers
    WHERE id=p_payer_id AND studio_id=p_studio_id FOR UPDATE;
    FOR v_owner IN
        SELECT * FROM public.billing_invoice_mutation_owners
        WHERE studio_id=p_studio_id AND payer_id=p_payer_id
        ORDER BY invoice_id FOR UPDATE
    LOOP
        SELECT * INTO v_operation FROM public.billing_provider_operations
        WHERE id=v_owner.operation_id FOR UPDATE;
        IF v_owner.operation_type<>'invoice.retry'
           OR v_operation.state IN ('completed','definitive_failed','definitive_rejected') THEN
            CONTINUE;
        END IF;
        IF v_operation.state NOT IN (
            'started','provider_request_in_flight','recovery_authorized'
        ) THEN
            CONTINUE;
        END IF;
        IF private.billing_invoice_retry_preread_zero_evidence_v33(
            v_operation,'present') THEN
            UPDATE public.billing_provider_operations SET
                state='definitive_rejected',
                error_code='invoice_retry_consent_changed_before_provider',
                definitive_rejected_at=v_now,
                invoice_retry_preread_released_at=NULL,
                invoice_retry_preread_release_reason=NULL,
                revision=revision+1,updated_at=v_now
            WHERE id=v_operation.id;
        ELSE
            RAISE EXCEPTION USING ERRCODE='55P03',
                MESSAGE='billing_invoice_mutation_in_progress';
        END IF;
    END LOOP;
END;
$$;
ALTER FUNCTION private.handle_invoice_retry_consent_change_v33(UUID,UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.handle_invoice_retry_consent_change_v33(UUID,UUID)
    FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.reject_consent_change_during_invoice_retry_v31()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_studio UUID; v_payer UUID;
BEGIN
    v_studio:=COALESCE(NEW.studio_id,OLD.studio_id);
    v_payer:=COALESCE(NEW.payer_id,OLD.payer_id);
    PERFORM private.handle_invoice_retry_consent_change_v33(v_studio,v_payer);
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.reject_consent_change_during_invoice_retry_v31() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reject_consent_change_during_invoice_retry_v31()
    FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.reject_payer_change_during_invoice_retry_v31()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF OLD.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id
       OR OLD.stripe_customer_id IS DISTINCT FROM NEW.stripe_customer_id
       OR OLD.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation THEN
        IF EXISTS(SELECT 1 FROM public.billing_invoice_mutation_owners AS owner
          JOIN public.billing_provider_operations AS operation ON operation.id=owner.operation_id
          WHERE owner.studio_id=NEW.studio_id AND owner.payer_id=NEW.id
            AND operation.state NOT IN ('completed','definitive_failed','definitive_rejected')) THEN
            RAISE EXCEPTION USING ERRCODE='55P03',
                MESSAGE='billing_invoice_mutation_in_progress';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD.default_payment_method_id IS DISTINCT FROM NEW.default_payment_method_id
       OR OLD.autopay_status IS DISTINCT FROM NEW.autopay_status
       OR OLD.autopay_authorized_at IS DISTINCT FROM NEW.autopay_authorized_at
       OR OLD.autopay_terms_accepted_at IS DISTINCT FROM NEW.autopay_terms_accepted_at THEN
        PERFORM private.handle_invoice_retry_consent_change_v33(NEW.studio_id,NEW.id);
    END IF;
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.reject_payer_change_during_invoice_retry_v31() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.reject_payer_change_during_invoice_retry_v31()
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.finalize_billing_invoice_retry_hash_capture_v33(
    p_expected_revision BIGINT,p_candidate_sha TEXT,p_drain_proof_sha256 TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_control private.billing_invoice_retry_hash_capture_control_v33%ROWTYPE;
        v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
    IF p_candidate_sha!~'^[0-9a-f]{40}$'
       OR p_drain_proof_sha256!~'^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE='22023',
            MESSAGE='billing_invoice_retry_hash_capture_finalize_invalid';
    END IF;
    SELECT * INTO v_control FROM private.billing_invoice_retry_hash_capture_control_v33
    WHERE singleton FOR UPDATE;
    IF v_control.revision IS DISTINCT FROM p_expected_revision THEN
        RAISE EXCEPTION USING ERRCODE='40001',
            MESSAGE='billing_invoice_retry_hash_capture_finalize_stale_revision';
    END IF;
    IF NOT v_control.capture_enabled THEN
        IF v_control.finalized_candidate_sha IS DISTINCT FROM p_candidate_sha
           OR v_control.finalized_proof_sha256 IS DISTINCT FROM p_drain_proof_sha256 THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_invoice_retry_hash_capture_finalize_conflict';
        END IF;
        RETURN jsonb_build_object('outcome','replay','revision',v_control.revision,
            'capture_enabled',false,'candidate_sha',v_control.finalized_candidate_sha);
    END IF;
    UPDATE private.billing_invoice_retry_hash_capture_control_v33 SET
        capture_enabled=false,revision=revision+1,
        finalized_candidate_sha=p_candidate_sha,
        finalized_proof_sha256=p_drain_proof_sha256,finalized_at=v_now
    WHERE singleton RETURNING * INTO v_control;
    RETURN jsonb_build_object('outcome','finalized','revision',v_control.revision,
        'capture_enabled',false,'candidate_sha',v_control.finalized_candidate_sha);
END;
$$;
ALTER FUNCTION public.finalize_billing_invoice_retry_hash_capture_v33(BIGINT,TEXT,TEXT)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finalize_billing_invoice_retry_hash_capture_v33(BIGINT,TEXT,TEXT)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.finalize_billing_invoice_retry_hash_capture_v33(BIGINT,TEXT,TEXT)
    TO service_role;

CREATE FUNCTION private.koaryu_release_invoice_retry_compatibility_manifest_v33()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_invalid INTEGER; v_serialized TEXT;
BEGIN
    WITH required_functions(signature,definer,service_execute) AS (VALUES
      ('private.billing_invoice_retry_base_hash_v33(uuid,uuid,text,text,integer)',false,false),
      ('private.billing_invoice_retry_preread_zero_evidence_v33(public.billing_provider_operations,text)',false,false),
      ('private.capture_billing_invoice_retry_hash_v33(uuid,uuid,uuid,uuid,uuid,text)',true,false),
      ('private.capture_billing_invoice_retry_resource_v33()',true,false),
      ('private.capture_billing_invoice_retry_alias_v33()',true,false),
      ('private.preserve_billing_invoice_retry_hash_ledger_v33()',false,false),
      ('private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)',true,false),
      ('private.handle_invoice_retry_consent_change_v33(uuid,uuid)',true,false),
      ('private.reject_consent_change_during_invoice_retry_v31()',true,false),
      ('private.reject_payer_change_during_invoice_retry_v31()',true,false),
      ('public.claim_billing_provider_operation_resource_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)',true,true),
      ('public.release_billing_invoice_retry_preread_lease_v33(uuid,uuid,uuid,text,text,text,integer,uuid,bigint,text)',true,true),
      ('public.finalize_billing_invoice_retry_hash_capture_v33(bigint,text,text)',true,true)
    ), function_state AS (
      SELECT required.*,procedure.oid,owner.rolname,procedure.prosecdef,
        COALESCE(array_to_string(procedure.proconfig,','),'') AS config,
        has_function_privilege('service_role',procedure.oid,'EXECUTE') AS sx,
        has_function_privilege('anon',procedure.oid,'EXECUTE') AS ax,
        has_function_privilege('authenticated',procedure.oid,'EXECUTE') AS ux,
        EXISTS(SELECT 1 FROM aclexplode(COALESCE(procedure.proacl,
          acldefault('f',procedure.proowner))) acl
          LEFT JOIN pg_roles grantee ON grantee.oid=acl.grantee
          WHERE acl.privilege_type='EXECUTE' AND acl.grantee<>procedure.proowner
            AND NOT(required.service_execute AND grantee.rolname='service_role'
              AND NOT acl.is_grantable)) AS unexpected,
        pg_get_functiondef(procedure.oid) AS definition
      FROM required_functions required
      LEFT JOIN pg_proc procedure ON procedure.oid=to_regprocedure(required.signature)
      LEFT JOIN pg_roles owner ON owner.oid=procedure.proowner
    ), required_triggers(name,relation,signature) AS (VALUES
      ('capture_billing_invoice_retry_resource_v33','billing_provider_operation_resources','private.capture_billing_invoice_retry_resource_v33()'),
      ('capture_billing_invoice_retry_alias_v33','billing_provider_operation_resource_aliases','private.capture_billing_invoice_retry_alias_v33()'),
      ('preserve_billing_invoice_retry_hash_ledger_v33','billing_invoice_retry_hash_ledger_v33','private.preserve_billing_invoice_retry_hash_ledger_v33()'),
      ('reject_consent_insert_during_invoice_retry_v31','billing_payer_payment_consents','private.reject_consent_change_during_invoice_retry_v31()'),
      ('reject_consent_update_during_invoice_retry_v31','billing_payer_payment_consents','private.reject_consent_change_during_invoice_retry_v31()'),
      ('reject_payer_change_during_invoice_retry_v31','billing_payers','private.reject_payer_change_during_invoice_retry_v31()')
    ), trigger_state AS (
      SELECT required.name,trigger.oid,trigger.tgenabled,
        trigger.tgfoid=to_regprocedure(required.signature) AS matches,
        pg_get_triggerdef(trigger.oid) AS definition
      FROM required_triggers required
      LEFT JOIN pg_class relation ON relation.relname=required.relation
       AND relation.relnamespace=CASE WHEN required.relation LIKE 'billing_invoice_retry_hash%'
         THEN 'private'::regnamespace ELSE 'public'::regnamespace END
      LEFT JOIN pg_trigger trigger ON trigger.tgrelid=relation.oid
       AND trigger.tgname=required.name AND NOT trigger.tgisinternal
    ), serialized AS (
      SELECT 'functions='||string_agg(signature||':'||COALESCE(definition,''),'|' ORDER BY signature) value
      FROM function_state UNION ALL
      SELECT 'triggers='||string_agg(name||':'||COALESCE(definition,''),'|' ORDER BY name)
      FROM trigger_state UNION ALL
      SELECT 'constraints='||string_agg(conname||':'||pg_get_constraintdef(oid),'|' ORDER BY conname)
      FROM pg_constraint WHERE conname IN(
       'billing_provider_operations_preread_release_marker_v33',
       'billing_invoice_retry_hash_capture_final_v33')
    )
    SELECT
      (SELECT count(*) FROM function_state WHERE oid IS NULL OR rolname<>'postgres'
        OR prosecdef IS DISTINCT FROM definer OR config<>CASE WHEN signature LIKE 'private.billing_invoice_retry_base_hash%' THEN 'search_path=pg_catalog' ELSE 'search_path=""' END
        OR sx IS DISTINCT FROM service_execute OR ax OR ux OR unexpected)
      +(SELECT count(*) FROM trigger_state WHERE oid IS NULL OR tgenabled<>'O' OR NOT matches)
      +CASE WHEN (SELECT count(*) FROM pg_constraint WHERE conname IN(
       'billing_provider_operations_preread_release_marker_v33',
       'billing_invoice_retry_hash_capture_final_v33'))=2 THEN 0 ELSE 1 END,
      string_agg(value,E'\n' ORDER BY value)
    INTO v_invalid,v_serialized FROM serialized;
    RETURN v_invalid::TEXT||':'||encode(extensions.digest(
      convert_to(COALESCE(v_serialized,''),'UTF8'),'sha256'),'hex');
END;
$$;
ALTER FUNCTION private.koaryu_release_invoice_retry_compatibility_manifest_v33() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_invoice_retry_compatibility_manifest_v33()
 FROM PUBLIC,anon,authenticated,service_role;

UPDATE private.koaryu_release_v31_expectations
SET expected_sha256='3fa8acfa06f919f1702a7dc9ff3616ce539fb0117a727a4e609c9c3aa50c29c2'
WHERE expectation_key='operational_contract_v31';

DO $build_v14$
DECLARE v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.koaryu_release_schema_preflight_v13()'::regprocedure)
  INTO v_definition;
  v_definition:=replace(v_definition,
    'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v13()',
    'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v14()');
  v_definition:=replace(v_definition,
    'v_count <> 127 OR v_head <> ''20260830065627''',
    'v_count <> 128 OR v_head <> ''20260830082610''');
  v_definition:=replace(v_definition,
    '''20260826185651'',''20260830065627''',
    '''20260826185651'',''20260830065627'',''20260830082610''');
  v_definition:=replace(v_definition,'''migration_history_v32''','''migration_history_v33''');
  v_definition:=replace(v_definition,'0:7003a83b5deea53d0c365ec3e2eca4dd5281f7658fe0a41d053c1e1618d709c1','0:f87c5626c11c3b93c55e94438551a0f500553e092b5790cef873adf0f90605af');
  v_definition:=replace(v_definition,'0:b0bf5a376dab5ece5a6d9e44b7ea3067ce7700200361c20f0b1f0166395f0c3b','0:3fa8acfa06f919f1702a7dc9ff3616ce539fb0117a727a4e609c9c3aa50c29c2');
  v_definition:=replace(v_definition,'0:1cc1c6760ff8e57e532813211ff70ca7cdb55aa1209fa1f6d029aee34b0b1624','0:00790561b8e54e31aea1f134bde617bec9b2b6f96d1372e9546ce91d10464331');
  v_definition:=replace(v_definition,'0:025214fa14bc7319a806cb6eba177d77af214d9ee6457959ca17e3e08347ce0f','0:4bc49993793e36641ed793161aeeb064ce3101b3a98e52365da15fc957ed4c5e');
  v_definition:=replace(v_definition,'0:8423e3fc0ba0d8e7ee9e5a9625f6078ca82f1998a766eb007c6d6433993e389a','0:33a270e015c8a73824d38785b1bb7b8fde7ea67ee2783832042f335627d64864');
  v_definition:=replace(v_definition,'0:48b8eff3f5470913614927bb0699970ea165a5ca5b5704cd73af08a9ec7dcdbb','0:93a90cb23af0a5ba2e4e97b938419f41cb770418f433c32ca4534dbfe65538c6');
  v_definition:=replace(v_definition,'eaead9e1d0d5696089de8a5c4e65dba15d6ba6b7e7fd47f8f911356bdc94420d','d9c4103b9109512eef453dd788989045a19d39ad0e8d59969ff5a48aaa78b2fb');
  v_definition:=replace(v_definition,'0:61d0fbbd8ab29d9ea43dc0137f467daa86bb6da97b1be19222710c81aeadc318','0:6389e87cdb8a5db79c540f38da4fdc71aa56ed10fa5d5533518f470bf52f7dfc');
  v_definition:=replace(v_definition,'26373f66ff1800369b7bad388a1b38452e48615b2635cc796d173a3fa92707fc','e74062ef628b63c87992d17e3980518baffaa18abe0e4a519179e49418449a88');
  v_definition:=replace(v_definition,
    'RETURN QUERY SELECT cardinality(v_failures) = 0,',
    $inject$IF private.koaryu_release_invoice_retry_compatibility_manifest_v33()
       <> '0:0fad0f4db714c0180e0107ec3e91d889a8aced2d506a8ef8ec8e151a23248154' THEN
      v_failures:=array_append(v_failures,'invoice_retry_compatibility_manifest_v33');
    END IF;
    RETURN QUERY SELECT cardinality(v_failures) = 0,$inject$);
  v_definition:=replace(v_definition,
    '''release-db-attestation-v32''::TEXT;',
    '''release-db-attestation-v33''::TEXT;');
  EXECUTE v_definition;
END;
$build_v14$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v14() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v14()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v14() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v13()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
 pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v_current RECORD;
BEGIN
  SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v14();
  IF v_current.ready AND v_current.migration_count=128
     AND v_current.migration_head='20260830082610' THEN
    RETURN QUERY SELECT true,127,'20260830065627'::TEXT,
      v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
      ARRAY[]::TEXT[],'release-db-attestation-v32'::TEXT;
    RETURN;
  END IF;
  RETURN QUERY SELECT false,v_current.migration_count,v_current.migration_head,
    v_current.pending_versions,v_current.security_failures,
    'release-db-attestation-v32'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v13() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v13()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v13() TO service_role;

DO $observe_v33$
BEGIN
 RAISE NOTICE 'KOARYU_V33_INVOICE_RETRY_COMPATIBILITY_MANIFEST=%',
  private.koaryu_release_invoice_retry_compatibility_manifest_v33();
 RAISE NOTICE 'KOARYU_V33_RESOURCE_V31=%',private.koaryu_release_resource_ownership_manifest_v31();
 RAISE NOTICE 'KOARYU_V33_CONTRACT_V27=%',private.koaryu_release_operational_contract_v27();
 RAISE NOTICE 'KOARYU_V33_CONTRACT_V28=%',private.koaryu_release_operational_contract_v28();
 RAISE NOTICE 'KOARYU_V33_CONTRACT_V29=%',private.koaryu_release_operational_contract_v29();
 RAISE NOTICE 'KOARYU_V33_CONTRACT_V30=%',private.koaryu_release_operational_contract_v30();
 RAISE NOTICE 'KOARYU_V33_CONTRACT_V31=%',private.koaryu_release_operational_contract_v31();
 RAISE NOTICE 'KOARYU_V33_MANIFEST_V11=%',private.koaryu_release_operational_manifest_v11();
 RAISE NOTICE 'KOARYU_V33_STEPS_V28=%',private.koaryu_release_provider_operation_steps_manifest_v28();
 RAISE NOTICE 'KOARYU_V33_MANIFEST_V12=%',private.koaryu_release_operational_manifest_v12();
END;
$observe_v33$;
