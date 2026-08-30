-- V34 closes the refund reservation and invoice closeout replay gaps found in
-- the V33 rehearsal. Historical migration bodies remain unchanged.

DO $v33_guard$
DECLARE v_preflight RECORD;
BEGIN
    SELECT * INTO v_preflight FROM public.koaryu_release_schema_preflight_v14();
    IF v_preflight.ready IS DISTINCT FROM true
       OR v_preflight.migration_count IS DISTINCT FROM 128
       OR v_preflight.migration_head IS DISTINCT FROM '20260830082610'
       OR v_preflight.manifest_version IS DISTINCT FROM 'release-db-attestation-v33'
       OR cardinality(v_preflight.security_failures) <> 0 THEN
        RAISE EXCEPTION 'Invoice retry closeout V34 requires exact ready 128/V33.';
    END IF;
END;
$v33_guard$;

DO $preserve_v14$
DECLARE v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef('public.koaryu_release_schema_preflight_v14()'::regprocedure)
    INTO v_definition;
  v_definition:=replace(v_definition,
    'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v14()',
    'CREATE OR REPLACE FUNCTION private.koaryu_release_schema_preflight_v14_snapshot_v34()');
  EXECUTE v_definition;
END;
$preserve_v14$;
ALTER FUNCTION private.koaryu_release_schema_preflight_v14_snapshot_v34() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_schema_preflight_v14_snapshot_v34()
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.enforce_billing_payment_refundable_amount_v31()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE v_reserved BIGINT:=0; v_expected INTEGER:=0;
BEGIN
    IF NEW.stripe_charge_id IS NOT NULL THEN
        SELECT COALESCE(SUM(GREATEST(refund.amount_cents,0)),0)
          INTO v_reserved
          FROM public.billing_refunds AS refund
         WHERE refund.payment_id=NEW.id
           AND refund.studio_id=NEW.studio_id
           AND refund.stripe_account_id IS NOT DISTINCT FROM NEW.stripe_account_id
           AND refund.connect_account_generation IS NOT DISTINCT FROM NEW.connect_account_generation
           AND refund.status IN ('pending','requires_action');
        v_expected:=GREATEST(
            NEW.net_collected_amount_cents
              - LEAST(NEW.net_collected_amount_cents::BIGINT,v_reserved)::INTEGER,0);
    END IF;
    IF NEW.refundable_amount_cents IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION USING ERRCODE='23514',
            MESSAGE='billing_payment_refundable_amount_not_exact';
    END IF;
    RETURN NEW;
END;
$$;
ALTER FUNCTION private.enforce_billing_payment_refundable_amount_v31() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.enforce_billing_payment_refundable_amount_v31()
 FROM PUBLIC,anon,authenticated,service_role;

DO $replace_refund_reservation$
DECLARE v_definition TEXT;
BEGIN
    SELECT pg_get_functiondef(
        'private.recompute_billing_payment_adjustment_totals(uuid)'::regprocedure)
      INTO v_definition;
    v_definition:=replace(
        v_definition,
        'FILTER (WHERE refund.status = ''pending'')',
        'FILTER (WHERE refund.status IN (''pending'',''requires_action''))');
    IF position('FILTER (WHERE refund.status IN (''pending'',''requires_action''))'
                IN v_definition)=0 THEN
        RAISE EXCEPTION 'Refund reservation function did not match the V33 body.';
    END IF;
    EXECUTE v_definition;
END;
$replace_refund_reservation$;

DO $refund_reservation_backfill$
DECLARE v_payment_id UUID;
BEGIN
    FOR v_payment_id IN
        SELECT DISTINCT refund.payment_id
          FROM public.billing_refunds AS refund
         WHERE refund.payment_id IS NOT NULL
           AND refund.status IN ('pending','requires_action')
         ORDER BY refund.payment_id
    LOOP
        PERFORM private.recompute_billing_payment_adjustment_totals(v_payment_id);
    END LOOP;
END;
$refund_reservation_backfill$;

DO $replace_invoice_retry_reclaim$
DECLARE v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)'::regprocedure)
    INTO v_definition;
  v_definition:=replace(v_definition,
$$    ELSE
        IF v_owner.operation_type='invoice.retry'
           AND v_operation.id IS NOT NULL
           AND v_operation.state NOT IN(
             'completed','definitive_failed','definitive_rejected')
           AND p_caller_request_key IS DISTINCT FROM v_operation.caller_request_key THEN$$,
$$    ELSE
        IF v_owner.operation_type='invoice.retry'
           AND v_operation.id IS NOT NULL
           AND v_operation.state NOT IN(
             'completed','definitive_failed','definitive_rejected')
           AND p_caller_request_key IS NOT DISTINCT FROM v_operation.caller_request_key THEN
            SELECT * INTO v_ledger_resource
              FROM public.billing_provider_operation_resources
             WHERE id=v_owner.resource_claim_id FOR UPDATE;
            IF v_operation.studio_id IS DISTINCT FROM p_studio_id
               OR v_operation.actor_id IS DISTINCT FROM p_actor_id
               OR v_operation.operation_type<>'invoice.retry'
               OR v_operation.stripe_connected_account_id
                    IS DISTINCT FROM p_stripe_connected_account_id
               OR v_operation.connect_account_generation
                    IS DISTINCT FROM p_connect_account_generation
               OR v_ledger_resource.id IS NULL
               OR v_ledger_resource.operation_id IS DISTINCT FROM v_operation.id
               OR v_ledger_resource.studio_id IS DISTINCT FROM p_studio_id
               OR v_ledger_resource.operation_type<>'invoice.retry'
               OR v_ledger_resource.resource_type<>'invoice'
               OR v_ledger_resource.resource_id IS DISTINCT FROM p_resource_id
               OR v_ledger_resource.payer_id IS DISTINCT FROM p_payer_id
               OR v_owner.operation_type<>'invoice.retry'
               OR v_owner.resource_type<>'invoice'
               OR p_requested_base_sha256 NOT IN (v_base,v_operation.request_sha256) THEN
                RAISE EXCEPTION USING ERRCODE='23505',
                    MESSAGE='billing_invoice_retry_v33_nonterminal_key_mismatch';
            END IF;
            v_persisted:=v_operation.request_sha256;
            v_outcome:=CASE
              WHEN p_requested_base_sha256=v_base AND v_persisted=v_base
                THEN 'base_hash_exact'
              WHEN p_requested_base_sha256=v_base
                THEN 'ledger_legacy_hash_accepted'
              ELSE 'ledger_legacy_hash_replay' END;
            v_reclaim_released:=v_operation.invoice_retry_preread_released_at IS NOT NULL;
        ELSIF v_owner.operation_type='invoice.retry'
           AND v_operation.id IS NOT NULL
           AND v_operation.state NOT IN(
             'completed','definitive_failed','definitive_rejected')
           AND p_caller_request_key IS DISTINCT FROM v_operation.caller_request_key THEN$$);
  v_definition:=replace(v_definition,
$$        v_persisted:=p_requested_base_sha256;
        v_outcome:=CASE WHEN v_persisted=v_base THEN 'base_hash_exact'
            ELSE 'capture_legacy_hash_created' END;
    END IF;
    IF v_reclaim_released THEN
        UPDATE public.billing_provider_operations SET
            invoice_retry_preread_released_at=NULL,
            invoice_retry_preread_release_reason=NULL,
            revision=revision+1,updated_at=v_now
        WHERE id=v_operation.id;$$,
$$        IF v_persisted IS NULL THEN
            v_persisted:=p_requested_base_sha256;
            v_outcome:=CASE WHEN v_persisted=v_base THEN 'base_hash_exact'
                ELSE 'capture_legacy_hash_created' END;
        END IF;
    END IF;
    IF v_reclaim_released THEN
        UPDATE public.billing_provider_operations SET
            invoice_retry_preread_released_at=NULL,
            invoice_retry_preread_release_reason=NULL,
            lease_owner=p_lease_owner,
            lease_acquired_at=v_now,
            lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),
            revision=revision+1,updated_at=v_now
        WHERE id=v_operation.id
          AND invoice_retry_preread_released_at IS NOT NULL;$$);
  v_definition:=replace(v_definition,
$$    v_result:=private.claim_billing_invoice_mutation_v31(
        p_studio_id,p_actor_id,'invoice.retry','invoice',p_resource_id,p_payer_id,
        p_caller_request_key,v_persisted,p_stripe_connected_account_id,
        p_connect_account_generation,p_lease_owner,p_lease_seconds
    );
    IF v_reclaim_released THEN
        SELECT private.billing_provider_operation_resource_json_v1(
            resource,operation,p_caller_request_key,'reclaimed'
        ) INTO v_result
        FROM public.billing_provider_operation_resources AS resource
        JOIN public.billing_provider_operations AS operation
          ON operation.id=resource.operation_id
        WHERE operation.id=v_owner.operation_id;
    END IF;$$,
$$    IF v_reclaim_released THEN
        SELECT private.billing_provider_operation_resource_json_v1(
            resource,operation,p_caller_request_key,'reclaimed'
        ) INTO v_result
        FROM public.billing_provider_operation_resources AS resource
        JOIN public.billing_provider_operations AS operation
          ON operation.id=resource.operation_id
        WHERE operation.id=v_owner.operation_id;
    ELSE
        v_result:=private.claim_billing_invoice_mutation_v31(
            p_studio_id,p_actor_id,'invoice.retry','invoice',p_resource_id,p_payer_id,
            p_caller_request_key,v_persisted,p_stripe_connected_account_id,
            p_connect_account_generation,p_lease_owner,p_lease_seconds
        );
    END IF;$$);
  IF position('v_ledger_resource.resource_id IS DISTINCT FROM p_resource_id' IN v_definition)=0
     OR position('lease_owner=p_lease_owner' IN v_definition)=0 THEN
    RAISE EXCEPTION 'Invoice retry V33 body did not match the V34 reclaim patch.';
  END IF;
  EXECUTE v_definition;
END;
$replace_invoice_retry_reclaim$;
ALTER FUNCTION private.claim_billing_invoice_retry_v33(
 UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.claim_billing_invoice_retry_v33(
 UUID,UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.claim_billing_invoice_closeout_operation_v1(
    p_studio_id UUID,p_actor_id UUID,p_operation_type TEXT,p_resource_type TEXT,
    p_resource_id UUID,p_payer_id UUID,p_caller_request_key TEXT,p_request_sha256 TEXT,
    p_stripe_connected_account_id TEXT,p_connect_account_generation INTEGER,
    p_lease_owner UUID,p_lease_seconds INTEGER DEFAULT 30
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_alias public.billing_provider_operation_resource_aliases%ROWTYPE;
        v_resource public.billing_provider_operation_resources%ROWTYPE;
        v_operation public.billing_provider_operations%ROWTYPE;
        v_owner public.billing_invoice_mutation_owners%ROWTYPE;
        v_current_operation public.billing_provider_operations%ROWTYPE;
        v_result JSONB;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.staff_roles AS membership
        WHERE membership.studio_id=p_studio_id
          AND membership.user_id=p_actor_id
          AND membership.archived_at IS NULL
          AND membership.role='admin'
    ) THEN
        RAISE EXCEPTION USING ERRCODE='42501',
            MESSAGE='billing_invoice_mutation_actor_forbidden';
    END IF;
    -- Certified terminal aliases replay before the fresh-mutation function
    -- checks the invoice's current draft/open state.
    SELECT * INTO v_alias
      FROM public.billing_provider_operation_resource_aliases
     WHERE studio_id=p_studio_id AND operation_type=p_operation_type
       AND caller_request_key=p_caller_request_key FOR UPDATE;
    IF FOUND THEN
        SELECT * INTO v_resource FROM public.billing_provider_operation_resources
         WHERE id=v_alias.resource_claim_id FOR UPDATE;
        SELECT * INTO v_operation FROM public.billing_provider_operations
         WHERE id=v_alias.operation_id FOR UPDATE;
        IF v_operation.state IN ('completed','definitive_failed','definitive_rejected') THEN
            IF v_resource.id IS NULL OR v_operation.id IS NULL
               OR v_alias.operation_id IS DISTINCT FROM v_operation.id
               OR v_alias.resource_claim_id IS DISTINCT FROM v_resource.id
               OR v_alias.studio_id IS DISTINCT FROM p_studio_id
               OR v_alias.operation_type IS DISTINCT FROM p_operation_type
               OR v_alias.resource_type IS DISTINCT FROM p_resource_type
               OR v_alias.resource_id IS DISTINCT FROM p_resource_id
               OR v_alias.payer_id IS DISTINCT FROM p_payer_id
               OR v_resource.studio_id IS DISTINCT FROM p_studio_id
               OR v_resource.operation_type IS DISTINCT FROM p_operation_type
               OR v_resource.resource_type IS DISTINCT FROM p_resource_type
               OR v_resource.resource_id IS DISTINCT FROM p_resource_id
               OR v_resource.payer_id IS DISTINCT FROM p_payer_id
               OR v_operation.studio_id IS DISTINCT FROM p_studio_id
               OR v_operation.operation_type IS DISTINCT FROM p_operation_type
               OR v_operation.actor_id IS DISTINCT FROM p_actor_id
               OR v_operation.caller_request_key IS DISTINCT FROM p_caller_request_key
               OR v_operation.request_sha256 IS DISTINCT FROM p_request_sha256
               OR v_operation.stripe_connected_account_id IS DISTINCT FROM p_stripe_connected_account_id
               OR v_operation.connect_account_generation IS DISTINCT FROM p_connect_account_generation THEN
                RAISE EXCEPTION USING ERRCODE='23505',
                    MESSAGE='billing_invoice_closeout_terminal_replay_mismatch';
            END IF;
            IF v_resource.operation_id IS DISTINCT FROM v_operation.id THEN
                SELECT * INTO v_owner
                  FROM public.billing_invoice_mutation_owners
                 WHERE studio_id=p_studio_id AND invoice_id=p_resource_id
                 FOR UPDATE;
                SELECT * INTO v_current_operation
                  FROM public.billing_provider_operations
                 WHERE id=v_resource.operation_id
                 FOR UPDATE;
                IF v_owner.operation_id IS DISTINCT FROM v_current_operation.id
                   OR v_owner.resource_claim_id IS DISTINCT FROM v_resource.id
                   OR v_owner.studio_id IS DISTINCT FROM p_studio_id
                   OR v_owner.invoice_id IS DISTINCT FROM p_resource_id
                   OR v_owner.payer_id IS DISTINCT FROM p_payer_id
                   OR v_owner.operation_type IS DISTINCT FROM p_operation_type
                   OR v_owner.resource_type IS DISTINCT FROM p_resource_type
                   OR v_current_operation.id IS NULL
                   OR v_current_operation.studio_id IS DISTINCT FROM p_studio_id
                   OR v_current_operation.operation_type IS DISTINCT FROM p_operation_type
                   OR v_current_operation.stripe_connected_account_id
                        IS DISTINCT FROM p_stripe_connected_account_id
                   OR v_current_operation.connect_account_generation
                        IS DISTINCT FROM p_connect_account_generation THEN
                    RAISE EXCEPTION USING ERRCODE='23505',
                        MESSAGE='billing_invoice_closeout_terminal_replay_mismatch';
                END IF;
            END IF;
            RETURN private.billing_provider_operation_resource_json_v1(
                v_resource,v_operation,p_caller_request_key,'replay');
        END IF;
    END IF;
    v_result:=private.claim_billing_invoice_mutation_v31(
        p_studio_id,p_actor_id,p_operation_type,p_resource_type,p_resource_id,
        p_payer_id,p_caller_request_key,p_request_sha256,
        p_stripe_connected_account_id,p_connect_account_generation,
        p_lease_owner,p_lease_seconds);
    SELECT * INTO v_current_operation
      FROM public.billing_provider_operations
     WHERE id=(v_result->'operation'->>'id')::UUID
     FOR UPDATE;
    IF v_current_operation.state='reconciliation_required'
       AND (v_current_operation.lease_owner IS NULL
            OR v_current_operation.lease_owner=p_lease_owner
            OR v_current_operation.lease_expires_at<=clock_timestamp()) THEN
        UPDATE public.billing_provider_operations SET
          lease_owner=p_lease_owner,
          lease_acquired_at=clock_timestamp(),
          lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
          revision=revision+1,
          updated_at=clock_timestamp()
        WHERE id=v_current_operation.id RETURNING * INTO v_current_operation;
        v_result:=jsonb_set(v_result,'{operation}',to_jsonb(v_current_operation));
    END IF;
    RETURN v_result;
END;
$$;
ALTER FUNCTION public.claim_billing_invoice_closeout_operation_v1(
 UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_billing_invoice_closeout_operation_v1(
 UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_billing_invoice_closeout_operation_v1(
 UUID,UUID,TEXT,TEXT,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,UUID,INTEGER) TO service_role;

CREATE FUNCTION private.koaryu_release_invoice_retry_closeout_manifest_v34()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_serialized TEXT;
BEGIN
    SELECT string_agg(item,';' ORDER BY item COLLATE "C") INTO v_serialized
    FROM (
      SELECT p.oid::regprocedure::TEXT||':'||p.prosecdef::TEXT||':'||
             COALESCE(array_to_string(p.proconfig,','),'')||':'||
             encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') AS item
      FROM pg_catalog.pg_proc p
      WHERE p.oid IN (
        'private.recompute_billing_payment_adjustment_totals(uuid)'::regprocedure,
        'private.enforce_billing_payment_refundable_amount_v31()'::regprocedure,
        'private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)'::regprocedure,
        'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'::regprocedure)
      UNION ALL
      SELECT 'acl:'||p.oid::regprocedure::TEXT||':'||COALESCE(array_to_string(p.proacl,','),'')
      FROM pg_catalog.pg_proc p
      WHERE p.oid IN (
        'private.recompute_billing_payment_adjustment_totals(uuid)'::regprocedure,
        'private.enforce_billing_payment_refundable_amount_v31()'::regprocedure,
        'private.claim_billing_invoice_retry_v33(uuid,uuid,uuid,uuid,text,text,text,integer,uuid,integer)'::regprocedure,
        'public.claim_billing_invoice_closeout_operation_v1(uuid,uuid,text,text,uuid,uuid,text,text,text,integer,uuid,integer)'::regprocedure)
    ) AS observed;
    RETURN '0:'||encode(extensions.digest(convert_to(COALESCE(v_serialized,''),'UTF8'),'sha256'),'hex');
END;
$$;
ALTER FUNCTION private.koaryu_release_invoice_retry_closeout_manifest_v34() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_invoice_retry_closeout_manifest_v34()
 FROM PUBLIC,anon,authenticated,service_role;

UPDATE private.koaryu_release_v31_expectations
SET expected_sha256='fc7ed200dc9e0c3eca44c4876be9f46178ef683840bf0ab603abd936746011ec'
WHERE expectation_key='operational_contract_v31';

DO $build_v15$
DECLARE v_definition TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'private.koaryu_release_schema_preflight_v14_snapshot_v34()'::regprocedure)
    INTO v_definition;
  v_definition:=replace(v_definition,
    'CREATE OR REPLACE FUNCTION private.koaryu_release_schema_preflight_v14_snapshot_v34()',
    'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v15()');
  v_definition:=replace(v_definition,
    'v_count <> 128 OR v_head <> ''20260830082610''',
    'v_count <> 129 OR v_head <> ''20260830151714''');
  v_definition:=replace(v_definition,
    '''20260830065627'',''20260830082610''',
    '''20260830065627'',''20260830082610'',''20260830151714''');
  v_definition:=replace(v_definition,'''migration_history_v33''','''migration_history_v34''');
  v_definition:=replace(v_definition,'0:021617e4a8372faed9d9bed47324511892c1e051fb03dcafb3eeb31ecd9e6a35','0:654743df6f669bf284ddd8d8b6bd9aef872bf8aa49ce6e545bd22cd376e537fc');
  v_definition:=replace(v_definition,'0:c25c355e7eae78a4c3d4079236316c058ad3dc06b09602cb319dbc16531332cc','0:8461239841e35fe5dfd5be685b43c8551a40301f7ac24f1ea5b61a8ab522ce54');
  v_definition:=replace(v_definition,'0:00790561b8e54e31aea1f134bde617bec9b2b6f96d1372e9546ce91d10464331','0:71bd6c57dd16c61d0cab4ec45f1902a1b1cdf14f85a5961880f262e5c9730738');
  v_definition:=replace(v_definition,'0:4bc49993793e36641ed793161aeeb064ce3101b3a98e52365da15fc957ed4c5e','0:f11329ea7fe8c06da904f598fdb89af7c5083449f4feb30486176cc1904c37b3');
  v_definition:=replace(v_definition,'0:33a270e015c8a73824d38785b1bb7b8fde7ea67ee2783832042f335627d64864','0:5d022e3d25e3c09fd56cc80fd26ed8e6233b5ce881ddcc60b6b8593d8801190a');
  v_definition:=replace(v_definition,'0:93a90cb23af0a5ba2e4e97b938419f41cb770418f433c32ca4534dbfe65538c6','0:a8407f8ec918be79e8296e19dc9bcc027aae5c1a33656e4efa946c441bb549b3');
  v_definition:=replace(v_definition,'0:85b57219a48b78e04a60f1e6d8ff39fc47d7fc3f586ad1aa5bde852f8b463917','0:fc7ed200dc9e0c3eca44c4876be9f46178ef683840bf0ab603abd936746011ec');
  v_definition:=replace(v_definition,'d9c4103b9109512eef453dd788989045a19d39ad0e8d59969ff5a48aaa78b2fb','4efd4aa009ac5aa761c26b290fdd9e3732f7a2acb2b0ded6607fac8e15258c53');
  v_definition:=replace(v_definition,'953cd8f92a9e907cc70ca7ec599ee58b7f55772b7b4fd1af06fad76b58bc2bf8','40d61f86ef8f35dbaf17da4dbcc62dcc9e084347fe4d03f2f25044e288ab226c');
  v_definition:=replace(v_definition,
    '0:378f6477266a8bd8d0babfff37c2747606bd9d8c5b98024b77d786715c05dbcb',
    '0:8497daa806dcd7e33992fe8ca76f3207eb36b41e5a976be781e3bf33b22d4fdb');
  v_definition:=replace(v_definition,
    'RETURN QUERY SELECT cardinality(v_failures) = 0,',
    $inject$IF private.koaryu_release_invoice_retry_closeout_manifest_v34()
       <> '0:50b9665371c5b3c9e71a5acef2711bb94d280fed760d4f785522cd6bdf9e8402' THEN
      v_failures:=array_append(v_failures,'invoice_retry_closeout_manifest_v34');
    END IF;
    RETURN QUERY SELECT cardinality(v_failures) = 0,$inject$);
  v_definition:=replace(v_definition,
    '''release-db-attestation-v33''::TEXT;',
    '''release-db-attestation-v34''::TEXT;');
  EXECUTE v_definition;
END;
$build_v15$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v15() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v15()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v15() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v14()
RETURNS TABLE(ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
 pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v_current RECORD;
BEGIN
  SELECT * INTO v_current FROM public.koaryu_release_schema_preflight_v15();
  IF v_current.ready AND v_current.migration_count=129
     AND v_current.migration_head='20260830151714' THEN
    RETURN QUERY SELECT true,128,'20260830082610'::TEXT,
      v_current.pending_versions[1:cardinality(v_current.pending_versions)-1],
      ARRAY[]::TEXT[],'release-db-attestation-v33'::TEXT;
    RETURN;
  END IF;
  RETURN QUERY SELECT false,v_current.migration_count,v_current.migration_head,
    v_current.pending_versions,v_current.security_failures,
    'release-db-attestation-v33'::TEXT;
END;
$$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v14() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v14()
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v14() TO service_role;
