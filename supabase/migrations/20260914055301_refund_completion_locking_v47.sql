-- A new refund compares the completed owner under its operation lock. No backfill.
-- Register this migration in the same transaction.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v27()')),'UTF8'),'sha256'),'hex')
        IS DISTINCT FROM '30de6e1a8ad840a7a44cdb9f600bde8d0ae6505c4a56890f6b83fcdbd8cec10e' THEN
        RAISE EXCEPTION 'V47 requires the reviewed full V46 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v27();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 141
       OR v.migration_head IS DISTINCT FROM '20260914033337'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v46'
       OR cardinality(v.security_failures) IS DISTINCT FROM 0
       OR cardinality(v.pending_versions) IS DISTINCT FROM 57
       OR v.pending_versions[57] IS DISTINCT FROM '20260914033337' THEN
        RAISE EXCEPTION 'V47 requires a fully verified V46 predecessor.';
    END IF;
END;
$predecessor$;

CREATE OR REPLACE FUNCTION private.claim_payment_payer_operation_resource_v31(
    p_studio_id UUID,p_actor_id UUID,p_operation_type TEXT,p_resource_type TEXT,
    p_resource_id UUID,p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
    v_payment public.billing_payments%ROWTYPE;
    v_refund public.billing_refunds%ROWTYPE;
    v_payer public.billing_payers%ROWTYPE;
    v_plan public.billing_plans%ROWTYPE;
    v_account public.studio_payment_accounts%ROWTYPE;
    v_resource public.billing_provider_operation_resources%ROWTYPE;
    v_alias public.billing_provider_operation_resource_aliases%ROWTYPE;
    v_operation public.billing_provider_operations%ROWTYPE;
    v_existing_key_operation_id UUID;
    v_current_resource_version TEXT;
    v_now TIMESTAMPTZ:=clock_timestamp();
    v_outcome TEXT;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_resource_id IS NULL
       OR p_lease_owner IS NULL
       OR NOT ((p_operation_type='payment.refund' AND p_resource_type='payment')
            OR (p_operation_type='payer.sync' AND p_resource_type='payer')
            OR (p_operation_type='plan.sync' AND p_resource_type='plan'))
       OR (p_resource_type='plan' AND p_payer_id IS NOT NULL)
       OR (p_resource_type<>'plan' AND p_payer_id IS NULL)
       OR p_request_sha256 !~ '^[0-9a-f]{64}$'
       OR p_connect_account_generation<=0
       OR octet_length(p_stripe_connected_account_id) NOT BETWEEN 1 AND 255
       OR octet_length(p_caller_request_key) NOT BETWEEN 1 AND 255
       OR p_caller_request_key IS DISTINCT FROM btrim(p_caller_request_key)
       OR p_caller_request_key~'[[:cntrl:]]'
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='billing_provider_operation_resource_claim_invalid';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.staff_roles
        WHERE studio_id=p_studio_id AND user_id=p_actor_id
          AND archived_at IS NULL AND role='admin') THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='billing_provider_operation_actor_not_active';
    END IF;

    IF p_resource_type='plan' THEN
        SELECT * INTO v_plan FROM public.billing_plans
        WHERE id=p_resource_id AND studio_id=p_studio_id FOR UPDATE;
        IF v_plan.id IS NULL OR v_plan.status='archived' OR v_plan.archived_at IS NOT NULL
           OR (
                v_plan.stripe_account_id IS NOT NULL
                AND v_plan.stripe_account_id IS DISTINCT FROM
                    p_stripe_connected_account_id
           ) THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_provider_operation_resource_plan_identity_mismatch';
        END IF;
    ELSIF p_resource_type='payment' THEN
        SELECT * INTO v_payment FROM public.billing_payments
        WHERE id=p_resource_id AND studio_id=p_studio_id FOR UPDATE;
        IF v_payment.id IS NULL OR v_payment.payer_id IS DISTINCT FROM p_payer_id
           OR v_payment.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
           OR v_payment.connect_account_generation IS DISTINCT FROM p_connect_account_generation
           OR v_payment.stripe_charge_id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_payment_identity_mismatch';
        END IF;
    ELSIF p_resource_id IS DISTINCT FROM p_payer_id THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_payer_identity_mismatch';
    END IF;
    IF p_resource_type<>'plan' THEN
        SELECT * INTO v_payer FROM public.billing_payers
        WHERE id=p_payer_id AND studio_id=p_studio_id FOR UPDATE;
    END IF;
    SELECT * INTO v_account FROM public.studio_payment_accounts
    WHERE studio_id=p_studio_id FOR UPDATE;
    IF v_account.studio_id IS NULL
       OR v_account.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR private.current_connect_account_generation(v_account.metadata)
            IS DISTINCT FROM p_connect_account_generation
       OR (p_resource_type<>'plan' AND v_payer.id IS NULL)
       OR (p_resource_type='payment' AND (
            v_payer.stripe_account_id IS DISTINCT FROM p_stripe_connected_account_id
            OR v_payer.connect_account_generation IS DISTINCT FROM p_connect_account_generation))
       OR (p_resource_type='payer' AND NOT (
            (v_payer.stripe_account_id IS NULL AND v_payer.stripe_customer_id IS NULL
             AND v_payer.connect_account_generation IS NULL)
            OR (v_payer.stripe_account_id=p_stripe_connected_account_id
                AND v_payer.connect_account_generation=p_connect_account_generation))) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_payer_identity_mismatch';
    END IF;
    v_current_resource_version := CASE
        WHEN p_resource_type='plan' THEN private.billing_plan_resource_version_v31(
            v_plan,
            p_stripe_connected_account_id,
            p_connect_account_generation
        )
        ELSE private.billing_operation_resource_version_v31(
            p_operation_type,
            v_payment,
            v_payer,
            p_stripe_connected_account_id,
            p_connect_account_generation
        )
    END;
    IF v_current_resource_version !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_provider_operation_resource_version_invalid';
    END IF;

    SELECT * INTO v_resource FROM public.billing_provider_operation_resources
    WHERE studio_id=p_studio_id AND resource_type=p_resource_type
      AND resource_id=p_resource_id FOR UPDATE;
    IF v_resource.id IS NOT NULL AND (
        v_resource.operation_type IS DISTINCT FROM p_operation_type
        OR v_resource.payer_id IS DISTINCT FROM p_payer_id) THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_request_conflict';
    END IF;
    SELECT * INTO v_alias FROM public.billing_provider_operation_resource_aliases
    WHERE studio_id=p_studio_id AND operation_type=p_operation_type
      AND caller_request_key=p_caller_request_key FOR UPDATE;
    IF FOUND THEN
        IF v_resource.id IS NULL OR v_alias.resource_claim_id IS DISTINCT FROM v_resource.id
           OR v_alias.resource_type IS DISTINCT FROM p_resource_type
           OR v_alias.resource_id IS DISTINCT FROM p_resource_id
           OR v_alias.payer_id IS DISTINCT FROM p_payer_id THEN
            RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_alias_conflict';
        END IF;
        SELECT * INTO v_operation FROM public.billing_provider_operations
        WHERE id=v_alias.operation_id FOR UPDATE;
        IF v_operation.actor_id IS DISTINCT FROM p_actor_id THEN
            RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_actor_conflict';
        END IF;
        IF v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
           OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
           OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
            RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_request_conflict';
        END IF;
        IF v_operation.state<>'completed'
           AND v_resource.resource_version_sha256 IS DISTINCT FROM
               v_current_resource_version THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_provider_operation_resource_version_conflict';
        END IF;
        IF v_operation.state IN ('started','recovery_authorized','provider_succeeded','projected')
           AND (v_operation.lease_owner IS NULL OR v_operation.lease_owner=p_lease_owner
                OR v_operation.lease_expires_at<=v_now) THEN
            UPDATE public.billing_provider_operations SET lease_owner=p_lease_owner,
                lease_acquired_at=v_now,lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
                revision=revision+1,updated_at=v_now WHERE id=v_operation.id
            RETURNING * INTO v_operation;
        END IF;
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource,v_operation,p_caller_request_key,'replay');
    END IF;

    IF v_resource.id IS NULL THEN
        INSERT INTO public.billing_provider_operations(studio_id,actor_id,operation_type,
            caller_request_key,request_sha256,stripe_connected_account_id,
            connect_account_generation,lease_owner,lease_acquired_at,lease_expires_at,
            started_at,created_at,updated_at)
        VALUES(p_studio_id,p_actor_id,p_operation_type,p_caller_request_key,p_request_sha256,
            p_stripe_connected_account_id,p_connect_account_generation,p_lease_owner,v_now,
            v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now)
        RETURNING * INTO v_operation;
        INSERT INTO public.billing_provider_operation_resources(operation_id,studio_id,
            operation_type,resource_type,resource_id,payer_id,
            resource_version_sha256,created_at,updated_at)
        VALUES(v_operation.id,p_studio_id,p_operation_type,p_resource_type,p_resource_id,
            p_payer_id,v_current_resource_version,v_now,v_now)
        RETURNING * INTO v_resource;
        INSERT INTO public.billing_provider_operation_resource_aliases(resource_claim_id,
            operation_id,studio_id,operation_type,resource_type,resource_id,payer_id,
            caller_request_key,created_at)
        VALUES(v_resource.id,v_operation.id,p_studio_id,p_operation_type,p_resource_type,
            p_resource_id,p_payer_id,p_caller_request_key,v_now);
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource,v_operation,p_caller_request_key,'claimed');
    END IF;

    SELECT * INTO v_operation FROM public.billing_provider_operations
    WHERE id=v_resource.operation_id FOR UPDATE;
    IF v_operation.state IN ('definitive_failed','definitive_rejected') THEN
        INSERT INTO public.billing_provider_operations(studio_id,actor_id,operation_type,
            caller_request_key,request_sha256,stripe_connected_account_id,
            connect_account_generation,lease_owner,lease_acquired_at,lease_expires_at,
            started_at,created_at,updated_at)
        VALUES(p_studio_id,p_actor_id,p_operation_type,p_caller_request_key,p_request_sha256,
            p_stripe_connected_account_id,p_connect_account_generation,p_lease_owner,v_now,
            v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now)
        RETURNING * INTO v_operation;
        UPDATE public.billing_provider_operation_resources SET operation_id=v_operation.id,
            resource_version_sha256=v_current_resource_version,
            revision=revision+1,updated_at=v_now
        WHERE id=v_resource.id RETURNING * INTO v_resource;
        INSERT INTO public.billing_provider_operation_resource_aliases(resource_claim_id,
            operation_id,studio_id,operation_type,resource_type,resource_id,payer_id,
            caller_request_key,created_at)
        VALUES(v_resource.id,v_operation.id,p_studio_id,p_operation_type,p_resource_type,
            p_resource_id,p_payer_id,p_caller_request_key,v_now);
        RETURN private.billing_provider_operation_resource_json_v1(
            v_resource,v_operation,p_caller_request_key,'replaced');
    END IF;
    IF v_operation.state='completed' AND p_resource_type='payment' THEN
        -- Completion may have committed while this claim waited for the operation lock.
        v_current_resource_version := private.billing_operation_resource_version_v31(
            p_operation_type,v_payment,v_payer,
            p_stripe_connected_account_id,p_connect_account_generation
        );
        SELECT * INTO v_refund FROM public.billing_refunds
        WHERE studio_id=p_studio_id
          AND payment_id=p_resource_id
          AND stripe_refund_id=v_operation.provider_object_id
          AND stripe_account_id=p_stripe_connected_account_id
          AND connect_account_generation=p_connect_account_generation
          AND reconciliation_required IS NOT TRUE
        ORDER BY created_at,id
        LIMIT 1
        FOR UPDATE;
        v_now := clock_timestamp();
    END IF;
    IF v_operation.actor_id IS DISTINCT FROM p_actor_id
       AND NOT (
            v_operation.state = 'completed'
            AND EXISTS (
                SELECT 1
                FROM public.staff_roles AS membership
                WHERE membership.studio_id = p_studio_id
                  AND membership.user_id = p_actor_id
                  AND membership.archived_at IS NULL
                  AND membership.role = 'admin'
            )
            AND (
                v_resource.resource_version_sha256 IS DISTINCT FROM
                    v_current_resource_version
                OR (
                    p_resource_type = 'payment'
                    AND v_refund.status IN ('failed', 'canceled')
                )
            )
       ) THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_actor_conflict';
    END IF;
    IF v_operation.state='completed' AND p_resource_type='payment' THEN
        IF v_resource.resource_version_sha256 IS NOT DISTINCT FROM
           v_current_resource_version
           AND v_operation.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
            RAISE EXCEPTION USING ERRCODE='23505',
                MESSAGE='billing_provider_operation_resource_request_conflict';
        END IF;
        IF v_refund.id IS NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514',
                MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
        END IF;
        IF v_resource.resource_version_sha256 IS NOT DISTINCT FROM
           v_current_resource_version
           AND v_refund.status NOT IN ('failed','canceled') THEN
            RAISE EXCEPTION USING ERRCODE='55000',
                MESSAGE='billing_provider_operation_resource_prior_refund_unsettled';
        END IF;
    END IF;
    IF v_operation.state='completed' AND (
        v_resource.resource_version_sha256 IS DISTINCT FROM v_current_resource_version
        OR (
            p_resource_type='payment'
            AND v_refund.status IN ('failed','canceled')
        )
    ) THEN
        IF p_resource_type='payment' THEN
            IF v_refund.id IS NULL THEN
                RAISE EXCEPTION USING ERRCODE='23514',
                    MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
            END IF;
        ELSIF p_resource_type='plan' THEN
            PERFORM 1
            FROM public.billing_provider_operation_steps AS step
            WHERE step.operation_id=v_operation.id
            ORDER BY step.step_order
            FOR UPDATE;
            IF v_operation.result_code IS DISTINCT FROM 'plan_sync_completed' THEN
                RAISE EXCEPTION USING ERRCODE='23514',
                    MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
            ELSIF v_operation.result_summary~
                  '^plan_sync_mode:product_update_only:target_product_id:prod_[A-Za-z0-9]+$' THEN
                IF v_operation.provider_object_id IS NULL
                   OR v_plan.stripe_product_id IS DISTINCT FROM v_operation.provider_object_id
                   OR v_plan.stripe_product_id IS DISTINCT FROM (regexp_match(
                        v_operation.result_summary,
                        'target_product_id:(prod_[A-Za-z0-9]+)$'
                      ))[1]
                   OR v_operation.provider_step_plan_sha256 IS NOT NULL
                   OR v_operation.provider_step_expected_count IS NOT NULL
                   OR EXISTS (
                        SELECT 1 FROM public.billing_provider_operation_steps AS step
                        WHERE step.operation_id=v_operation.id
                   ) THEN
                    RAISE EXCEPTION USING ERRCODE='23514',
                        MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
                END IF;
            ELSIF v_operation.result_summary='plan_sync_mode:product_price_steps' THEN
                IF v_operation.provider_step_plan_sha256 !~ '^[0-9a-f]{64}$'
                   OR v_operation.provider_step_expected_count IS DISTINCT FROM 2
                   OR v_operation.provider_object_id IS DISTINCT FROM v_plan.stripe_price_id
                   OR (SELECT count(*) FROM public.billing_provider_operation_steps AS step
                       WHERE step.operation_id=v_operation.id) <> 2
                   OR NOT EXISTS (
                        SELECT 1
                        FROM public.billing_provider_operation_steps AS step
                        WHERE step.operation_id=v_operation.id
                          AND step.step_order=1
                          AND step.step_name='product'
                          AND step.provider_operation IN (
                              'connected_product.create','connected_product.update'
                          )
                          AND step.state='provider_succeeded'
                          AND step.provider_request_attempt_count=1
                          AND step.result_code='plan_sync_product_succeeded'
                          AND step.provider_object_id=v_plan.stripe_product_id
                    )
                   OR NOT EXISTS (
                        SELECT 1
                        FROM public.billing_provider_operation_steps AS step
                        WHERE step.operation_id=v_operation.id
                          AND step.step_order=2
                          AND step.step_name='price'
                          AND step.provider_operation='connected_price.create'
                          AND step.state='provider_succeeded'
                          AND step.provider_request_attempt_count=1
                          AND step.result_code='plan_sync_price_succeeded'
                          AND step.provider_object_id=v_plan.stripe_price_id
                    ) THEN
                    RAISE EXCEPTION USING ERRCODE='23514',
                        MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
                END IF;
            ELSE
                RAISE EXCEPTION USING ERRCODE='23514',
                    MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
            END IF;
        ELSIF p_resource_type='payer' AND (
            v_payer.stripe_customer_id IS DISTINCT FROM v_operation.provider_object_id
            OR NOT (
                (v_operation.result_summary=
                    'sync_mode:create:target_customer_id:none')
                OR (
                    v_operation.result_summary~
                        '^sync_mode:update:target_customer_id:cus_[A-Za-z0-9]+$'
                    AND (regexp_match(
                        v_operation.result_summary,
                        'target_customer_id:(cus_[A-Za-z0-9]+)$'
                    ))[1] IS NOT NULL
                )
            )
        ) THEN
            RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='billing_provider_operation_resource_prior_projection_unverified';
        END IF;
        INSERT INTO public.billing_provider_operations(studio_id,actor_id,operation_type,caller_request_key,request_sha256,stripe_connected_account_id,connect_account_generation,lease_owner,lease_acquired_at,lease_expires_at,started_at,created_at,updated_at)
        VALUES(p_studio_id,p_actor_id,p_operation_type,p_caller_request_key,p_request_sha256,p_stripe_connected_account_id,p_connect_account_generation,p_lease_owner,v_now,v_now+make_interval(secs=>p_lease_seconds),v_now,v_now,v_now) RETURNING * INTO v_operation;
        UPDATE public.billing_provider_operation_resources
        SET operation_id=v_operation.id,
            resource_version_sha256=v_current_resource_version,
            revision=revision+1,
            updated_at=v_now
        WHERE id=v_resource.id RETURNING * INTO v_resource;
        INSERT INTO public.billing_provider_operation_resource_aliases(resource_claim_id,operation_id,studio_id,operation_type,resource_type,resource_id,payer_id,caller_request_key,created_at)
        VALUES(v_resource.id,v_operation.id,p_studio_id,p_operation_type,p_resource_type,p_resource_id,p_payer_id,p_caller_request_key,v_now);
        RETURN private.billing_provider_operation_resource_json_v1(v_resource,v_operation,p_caller_request_key,'replaced');
    END IF;
    IF v_resource.resource_version_sha256 IS DISTINCT FROM
       v_current_resource_version THEN
        RAISE EXCEPTION USING ERRCODE='23505',
            MESSAGE='billing_provider_operation_resource_version_conflict';
    END IF;
    IF v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_request_conflict';
    END IF;
    SELECT id INTO v_existing_key_operation_id FROM public.billing_provider_operations
    WHERE studio_id=p_studio_id AND operation_type=p_operation_type
      AND caller_request_key=p_caller_request_key;
    IF v_existing_key_operation_id IS NOT NULL
       AND v_existing_key_operation_id IS DISTINCT FROM v_operation.id THEN
        RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_alias_conflict';
    END IF;
    IF v_operation.state='recovery_authorized'
       AND p_caller_request_key IS DISTINCT FROM v_operation.caller_request_key THEN
        RAISE EXCEPTION USING ERRCODE='55P03',
            MESSAGE='billing_provider_operation_recovery_in_progress';
    END IF;
    IF (SELECT count(*) FROM public.billing_provider_operation_resource_aliases
        WHERE operation_id=v_operation.id)>=64 THEN
        RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='billing_provider_operation_resource_alias_limit';
    END IF;
    INSERT INTO public.billing_provider_operation_resource_aliases(resource_claim_id,
        operation_id,studio_id,operation_type,resource_type,resource_id,payer_id,
        caller_request_key,created_at)
    VALUES(v_resource.id,v_operation.id,p_studio_id,p_operation_type,p_resource_type,
        p_resource_id,p_payer_id,p_caller_request_key,v_now);
    IF v_operation.state IN ('started','recovery_authorized','provider_succeeded','projected')
       AND (v_operation.lease_owner IS NULL OR v_operation.lease_owner=p_lease_owner
            OR v_operation.lease_expires_at<=v_now) THEN
        UPDATE public.billing_provider_operations SET lease_owner=p_lease_owner,
            lease_acquired_at=v_now,lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
            revision=revision+1,updated_at=v_now WHERE id=v_operation.id
        RETURNING * INTO v_operation;
    END IF;
    v_outcome:=CASE WHEN v_operation.state='reconciliation_required' THEN 'reconciliation_required'
        WHEN v_operation.state='provider_request_in_flight' THEN 'provider_request_in_flight'
        ELSE 'adopted' END;
    RETURN private.billing_provider_operation_resource_json_v1(
        v_resource,v_operation,p_caller_request_key,v_outcome);
EXCEPTION WHEN unique_violation THEN
    IF SQLERRM IN (
        'billing_provider_operation_resource_request_conflict',
        'billing_provider_operation_resource_alias_conflict',
        'billing_provider_operation_resource_actor_conflict',
        'billing_provider_operation_resource_version_conflict'
    ) THEN
        RAISE;
    END IF;
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='billing_provider_operation_resource_alias_conflict';
END;
$$;
ALTER FUNCTION private.claim_payment_payer_operation_resource_v31(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.claim_payment_payer_operation_resource_v31(
    UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER
) FROM PUBLIC,anon,authenticated,service_role;

DO $expectation$
DECLARE changed INTEGER;
BEGIN
    IF (SELECT count(*) FROM private.koaryu_release_v31_expectations) IS DISTINCT FROM 1
       OR (SELECT expected_sha256 FROM private.koaryu_release_v31_expectations WHERE expectation_key='operational_contract_v31')
          IS DISTINCT FROM 'b20e8b04bb440f43cfd1bdc8ae8b011a217b0ee102f5729bc1caf837b133e1b8'
       OR private.koaryu_release_resource_ownership_manifest_v31()
          IS DISTINCT FROM '0:a0dbde4e4447bd0bd279dd097be2ecc67eec9f6e75c83d11ca3a0fef2149e306'
       OR private.koaryu_release_operational_contract_v31()
          IS DISTINCT FROM '0:ffa4cfd247016d2162440de6c2d5f67f29ef90566075a88f7b6e484bed041e18' THEN
        RAISE EXCEPTION 'V47 requires the reviewed refund contract and original V31 expectation.';
    END IF;
    UPDATE private.koaryu_release_v31_expectations
    SET expected_sha256='ffa4cfd247016d2162440de6c2d5f67f29ef90566075a88f7b6e484bed041e18'
    WHERE expectation_key='operational_contract_v31'
      AND expected_sha256='b20e8b04bb440f43cfd1bdc8ae8b011a217b0ee102f5729bc1caf837b133e1b8';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed IS DISTINCT FROM 1 OR private.koaryu_release_operational_manifest_v12()
       IS DISTINCT FROM '2403d556a024b07689002f8efa68dd6448bade1fdf6bf823d6a80952556105c2' THEN
        RAISE EXCEPTION 'V47 guarded expectation correction did not verify.';
    END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v28()
 RETURNS TABLE(ready boolean, migration_count integer, migration_head text, pending_versions text[], security_failures text[], manifest_version text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
    IF v_count <> 142 OR v_head <> '20260914055301' THEN
        v_failures := array_append(v_failures, 'migration_history_v47');
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
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133','20260910185031','20260914033337','20260914055301'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:a0dbde4e4447bd0bd279dd097be2ecc67eec9f6e75c83d11ca3a0fef2149e306' THEN
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
       <> '0:556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136' THEN
        v_failures := array_append(v_failures, 'operational_contract_v26');
    END IF;
    IF private.koaryu_release_operational_contract_v27()
       <> '0:855d548e95744f3aede9b09986be342a935cef092ccd583e38e2febfba8fe6f6' THEN
        v_failures := array_append(v_failures, 'operational_contract_v27');
    END IF;
    IF private.koaryu_release_operational_contract_v28()
       <> '0:60fabacbd8f58f14d7ed25764fb6016ef44d6d3dfc926900793f52c1e3d7d13d' THEN
        v_failures := array_append(v_failures, 'operational_contract_v28');
    END IF;
    IF private.koaryu_release_operational_contract_v29()
       <> '0:32706cfae7047b70ee6b563048ffafa91d945bc824939e3000fa01631a459ecb' THEN
        v_failures := array_append(v_failures, 'operational_contract_v29');
    END IF;
    IF private.koaryu_release_operational_contract_v30()
       <> '0:2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23' THEN
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
       <> '2efb0b2cf73beabfb219dd3642a824714c1b0619c5498ecf195071f929e651f6' THEN
        v_failures := array_append(v_failures, 'operational_manifest_v11');
    END IF;
    IF private.koaryu_release_provider_operation_steps_manifest_v28()
       <> '0:6389e87cdb8a5db79c540f38da4fdc71aa56ed10fa5d5533518f470bf52f7dfc' THEN
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
       <> '0:3c2a6854c73a6e9c9704fabed38dac85b56eb26076add20c00ee97bed5bdc527' THEN
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
       IS DISTINCT FROM '2403d556a024b07689002f8efa68dd6448bade1fdf6bf823d6a80952556105c2' THEN
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
       <> '0:d054ae0cf5ce43ce2c241ca628e0724b5239bd696c323ba9c817b8bd21ee0eec' THEN
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
  ('public.billing_landing_aggregates(uuid,timestamptz,timestamptz)','7adf5dc3a58e5f96aa87c3a4c1e4f509b081e97185a104e8d8239ad1fae2a222'),
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
              = '0eb78ae7d2c51c73bb17011e2cb0249f3fdb580e7a6293bc92f549771af646cd'
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
              = '9bc03bc31ae70310497bfa020088045b604e113550d79e1a9c6c754b58ec2876'
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
              = '8a735334eb60047f7dfd06490949b9286cc693eb1fd7990900aa58d8d8c9b661'
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
       IS DISTINCT FROM '0:4653774cb7fcf2f85c70dcb9284ee01d25051ebf4552520a0fa95eb929cafb9f' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_v45');
    END IF;
    IF encode(extensions.digest(convert_to(pg_get_functiondef(
        'private.koaryu_release_student_rank_writer_manifest_v13()'::REGPROCEDURE
    ), 'UTF8'), 'sha256'), 'hex')
       <> '7a1d1b52edfbda7d2ac942516bb0d2224af757a9d1278996d6225e8b94956578' THEN
        v_failures := array_append(v_failures, 'import_rank_manifest_definition_v45');
    END IF;
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v47'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v27()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v28();
    IF v.ready IS TRUE AND v.migration_count = 142 AND v.migration_head = '20260914055301'
       AND v.manifest_version = 'release-db-attestation-v47'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 58
       AND v.pending_versions[cardinality(v.pending_versions)] = '20260914055301' THEN
        RETURN QUERY SELECT TRUE, 141, '20260914033337'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v46'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v46'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v28() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v28() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v28() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v27() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v27() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v27() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v28();
    IF v.migration_count IS DISTINCT FROM 141 OR v.migration_head IS DISTINCT FROM '20260914033337'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v47',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V47 installed contracts did not verify before history registration: %', row_to_json(v);
    END IF;
END;
$installed$;
