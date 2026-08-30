-- Release an invoice retry lease only when no provider mutation was attempted.
-- This gives typed provider preread failures a safe, atomic handoff path.

DO $v31_guard$
DECLARE
    v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight
    FROM public.koaryu_release_schema_preflight_v12();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 126
       OR v_preflight.migration_head IS DISTINCT FROM '20260826185651'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v31'
       OR COALESCE(v_preflight.security_failures, ARRAY[]::TEXT[]) <> ARRAY[]::TEXT[] THEN
        RAISE EXCEPTION 'Invoice retry preread lease release requires the exact ready 126/V31 predecessor.';
    END IF;
END;
$v31_guard$;

CREATE FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
    p_operation_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_caller_request_key TEXT,
    p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,
    p_connect_account_generation INTEGER,
    p_lease_owner UUID,
    p_expected_revision BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_operation public.billing_provider_operations%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT * INTO v_operation
    FROM public.billing_provider_operations
    WHERE id = p_operation_id
    FOR UPDATE;

    IF v_operation.id IS NULL
       OR v_operation.studio_id IS DISTINCT FROM p_studio_id
       OR v_operation.actor_id IS DISTINCT FROM p_actor_id
       OR v_operation.operation_type <> 'invoice.retry'
       OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
       OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
       OR v_operation.stripe_connected_account_id
            IS DISTINCT FROM p_stripe_connected_account_id
       OR v_operation.connect_account_generation
            IS DISTINCT FROM p_connect_account_generation THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'billing_invoice_retry_preread_release_identity_mismatch';
    END IF;
    IF v_operation.revision IS DISTINCT FROM p_expected_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001',
            MESSAGE = 'billing_invoice_retry_preread_release_stale_revision';
    END IF;
    IF v_operation.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_operation.lease_owner IS NULL
       OR v_operation.lease_acquired_at IS NULL
       OR v_operation.lease_acquired_at > v_now
       OR v_operation.lease_expires_at IS NULL
       OR v_operation.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'billing_invoice_retry_preread_release_lease_not_current';
    END IF;
    IF v_operation.state <> 'started'
       OR v_operation.provider_request_attempt_count <> 0
       OR v_operation.provider_object_id IS NOT NULL
       OR v_operation.provider_secondary_object_id IS NOT NULL
       OR v_operation.provider_request_id IS NOT NULL
       OR v_operation.result_code IS NOT NULL
       OR v_operation.result_summary IS NOT NULL
       OR v_operation.error_code IS NOT NULL
       OR v_operation.error_summary IS NOT NULL
       OR v_operation.reconciliation_reason_code IS NOT NULL
       OR v_operation.recovery_proof_sha256 IS NOT NULL
       OR v_operation.recovery_outcome IS NOT NULL
       OR v_operation.recovery_actor_id IS NOT NULL
       OR v_operation.recovery_authorized_at IS NOT NULL
       OR v_operation.provider_request_in_flight_at IS NOT NULL
       OR v_operation.provider_succeeded_at IS NOT NULL
       OR v_operation.projected_at IS NOT NULL
       OR v_operation.completed_at IS NOT NULL
       OR v_operation.reconciliation_required_at IS NOT NULL
       OR v_operation.definitive_failed_at IS NOT NULL
       OR v_operation.definitive_rejected_at IS NOT NULL
       OR v_operation.provider_step_plan_sha256 IS NOT NULL
       OR v_operation.provider_step_expected_count IS NOT NULL
       OR v_operation.provider_step_plan_registered_at IS NOT NULL
       OR EXISTS (
            SELECT 1
            FROM public.billing_provider_operation_steps AS step
            WHERE step.operation_id = v_operation.id
              AND (
                  step.provider_request_attempt_count <> 0
                  OR step.state <> 'pending'
                  OR step.provider_object_id IS NOT NULL
                  OR step.provider_secondary_object_id IS NOT NULL
                  OR step.provider_request_id IS NOT NULL
                  OR step.result_code IS NOT NULL
                  OR step.error_code IS NOT NULL
                  OR step.reconciliation_reason_code IS NOT NULL
                  OR step.recovery_proof_sha256 IS NOT NULL
                  OR step.recovery_outcome IS NOT NULL
                  OR step.recovery_actor_id IS NOT NULL
                  OR step.recovery_authorized_at IS NOT NULL
                  OR step.provider_request_in_flight_at IS NOT NULL
                  OR step.provider_succeeded_at IS NOT NULL
                  OR step.reconciliation_required_at IS NOT NULL
                  OR step.definitive_failed_at IS NOT NULL
                  OR step.definitive_rejected_at IS NOT NULL
              )
       ) THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
            MESSAGE = 'billing_invoice_retry_preread_release_mutation_evidence';
    END IF;

    UPDATE public.billing_provider_operations
    SET lease_owner = NULL,
        lease_acquired_at = NULL,
        lease_expires_at = NULL,
        revision = revision + 1,
        updated_at = v_now
    WHERE id = v_operation.id
    RETURNING * INTO v_operation;

    RETURN jsonb_build_object(
        'outcome', 'released',
        'operation', jsonb_build_object(
            'id', v_operation.id,
            'studio_id', v_operation.studio_id,
            'actor_id', v_operation.actor_id,
            'operation_type', v_operation.operation_type,
            'caller_request_key', v_operation.caller_request_key,
            'request_sha256', v_operation.request_sha256,
            'stripe_connected_account_id', v_operation.stripe_connected_account_id,
            'connect_account_generation', v_operation.connect_account_generation,
            'state', v_operation.state,
            'provider_request_attempt_count', v_operation.provider_request_attempt_count,
            'provider_object_id', v_operation.provider_object_id,
            'provider_secondary_object_id', v_operation.provider_secondary_object_id,
            'provider_request_id', v_operation.provider_request_id,
            'lease_owner', v_operation.lease_owner,
            'lease_acquired_at', v_operation.lease_acquired_at,
            'lease_expires_at', v_operation.lease_expires_at,
            'revision', v_operation.revision,
            'updated_at', v_operation.updated_at
        )
    );
END;
$function$;

ALTER FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
    UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
    UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.release_billing_invoice_retry_preread_lease_v32(
    UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,BIGINT
) TO service_role;

CREATE FUNCTION private.koaryu_release_invoice_retry_preread_manifest_v32()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
    WITH function_state AS (
        SELECT procedure.oid, owner.rolname AS owner_name, procedure.prosecdef,
               COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
               has_function_privilege('service_role', procedure.oid, 'EXECUTE') AS service_execute,
               has_function_privilege('anon', procedure.oid, 'EXECUTE') AS anon_execute,
               has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS auth_execute,
               EXISTS (
                   SELECT 1 FROM aclexplode(COALESCE(
                       procedure.proacl, acldefault('f', procedure.proowner)
                   )) AS privilege
                   WHERE privilege.grantee = 0
                     AND privilege.privilege_type = 'EXECUTE'
               ) AS public_execute,
               (
                   SELECT count(*) = 1
                      AND bool_and(grantee.rolname = 'service_role')
                      AND NOT bool_or(privilege.is_grantable)
                   FROM aclexplode(COALESCE(
                       procedure.proacl, acldefault('f', procedure.proowner)
                   )) AS privilege
                   LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
                   WHERE privilege.privilege_type = 'EXECUTE'
                     AND privilege.grantee <> procedure.proowner
               ) AS exact_non_owner_execute_acl,
               pg_get_functiondef(procedure.oid) AS definition
        FROM pg_proc AS procedure
        JOIN pg_roles AS owner ON owner.oid = procedure.proowner
        WHERE procedure.oid = to_regprocedure(
            'public.release_billing_invoice_retry_preread_lease_v32(uuid,uuid,uuid,text,text,text,integer,uuid,bigint)'
        )
    )
    SELECT CASE WHEN count(*) = 1
                     AND bool_and(owner_name = 'postgres')
                     AND bool_and(prosecdef)
                     AND bool_and(configuration = 'search_path=""')
                     AND bool_and(service_execute)
                     AND bool_and(exact_non_owner_execute_acl)
                     AND NOT bool_or(anon_execute OR auth_execute OR public_execute)
                THEN '0:' ELSE '1:' END
           || encode(extensions.digest(convert_to(
                COALESCE(string_agg(definition, ''), ''), 'UTF8'
              ), 'sha256'), 'hex')
    FROM function_state;
$$;
ALTER FUNCTION private.koaryu_release_invoice_retry_preread_manifest_v32()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_invoice_retry_preread_manifest_v32()
    FROM PUBLIC,anon,authenticated,service_role;

-- Derive V13 from the complete V12 body so every inherited V31 catalog,
-- function-body, ACL, expectation-table, and operational-manifest check stays
-- in the final gate. The replacements only advance history and add the V32 RPC.
DO $build_v13$
DECLARE
    v_definition TEXT;
BEGIN
    SELECT pg_get_functiondef(
        'public.koaryu_release_schema_preflight_v12()'::REGPROCEDURE
    ) INTO v_definition;
    v_definition := replace(
        v_definition,
        'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v12()',
        'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v13()'
    );
    v_definition := replace(
        v_definition,
        'v_count <> 126 OR v_head <> ''20260826185651''',
        'v_count <> 127 OR v_head <> ''20260830065627'''
    );
    v_definition := replace(
        v_definition,
        '''20260826155911'',''20260826185651''',
        '''20260826155911'',''20260826185651'',''20260830065627'''
    );
    v_definition := replace(
        v_definition,
        '''migration_history_v31''',
        '''migration_history_v32'''
    );
    v_definition := replace(
        v_definition,
        'RETURN QUERY SELECT cardinality(v_failures) = 0,',
        $injected$IF private.koaryu_release_invoice_retry_preread_manifest_v32()
           <> '0:9c658ccd26b813cabc195023f2cac43a76b7c2dff4558b3f68659ad9c70c6cf5' THEN
            v_failures := array_append(
                v_failures,'invoice_retry_preread_manifest_v32'
            );
        END IF;
        RETURN QUERY SELECT cardinality(v_failures) = 0,$injected$
    );
    v_definition := replace(
        v_definition,
        '''release-db-attestation-v31''::TEXT;',
        '''release-db-attestation-v32''::TEXT;'
    );
    EXECUTE v_definition;
END;
$build_v13$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v13() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v13()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v13()
    TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v12()
RETURNS TABLE(
    ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = pg_catalog AS $$
DECLARE v_current RECORD;
BEGIN
    SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v13();
    IF v_current.ready
       AND v_current.migration_count = 127
       AND v_current.migration_head = '20260830065627' THEN
        RETURN QUERY SELECT true, 126, '20260826185651'::TEXT,
            v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v31'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT false, v_current.migration_count, v_current.migration_head,
        v_current.pending_versions, v_current.security_failures,
        'release-db-attestation-v31'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v12() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v12()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v12()
    TO service_role;

DO $v32_observation$
BEGIN
    RAISE NOTICE 'KOARYU_V32_INVOICE_RETRY_PREREAD_MANIFEST=%',
        private.koaryu_release_invoice_retry_preread_manifest_v32();
END;
$v32_observation$;
