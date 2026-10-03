-- V37 repairs refund/dispute identity updates discovered by the production
-- V36 canary. PostgreSQL can resolve OLD/NEW fields before a combined Boolean
-- table-name guard protects them, so branch on TG_TABLE_NAME first.
DO $guard$
DECLARE v_ready RECORD;
BEGIN
    SELECT * INTO v_ready FROM public.koaryu_release_schema_preflight_v17();
    IF v_ready.ready IS DISTINCT FROM true
       OR v_ready.migration_count <> 131
       OR v_ready.migration_head <> '20260831054918'
       OR v_ready.manifest_version <> 'release-db-attestation-v36'
       OR cardinality(v_ready.security_failures) <> 0 THEN
        RAISE EXCEPTION 'Adjustment trigger guard V37 requires exact ready V36.';
    END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION private.validate_billing_adjustment_payment_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_payment public.billing_payments%ROWTYPE;
    v_old_payment_id UUID;
    v_new_payment_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        v_old_payment_id := OLD.payment_id;
    END IF;

    v_new_payment_id := NEW.payment_id;

    PERFORM 1
    FROM public.billing_payments AS payment
    WHERE payment.id = ANY (
        array_remove(ARRAY[v_old_payment_id, v_new_payment_id], NULL::UUID)
    )
    ORDER BY payment.id
    FOR UPDATE;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.studio_id IS DISTINCT FROM NEW.studio_id
           OR (
                OLD.payment_id IS NOT NULL
                AND OLD.payment_id IS DISTINCT FROM NEW.payment_id
           )
           OR (
                OLD.stripe_account_id IS NOT NULL
                AND OLD.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id
           )
           OR (
                OLD.connect_account_generation IS NOT NULL
                AND OLD.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
           )
           OR (
                OLD.stripe_charge_id IS NOT NULL
                AND OLD.stripe_charge_id IS DISTINCT FROM NEW.stripe_charge_id
           )
           OR (
                OLD.stripe_payment_intent_id IS NOT NULL
                AND OLD.stripe_payment_intent_id IS DISTINCT FROM NEW.stripe_payment_intent_id
           ) THEN
            RAISE EXCEPTION 'Established billing adjustment identity cannot change.'
                USING ERRCODE = '23514';
        END IF;

        IF TG_TABLE_NAME = 'billing_refunds' THEN
            IF OLD.stripe_refund_id IS NOT NULL
               AND OLD.stripe_refund_id IS DISTINCT FROM NEW.stripe_refund_id THEN
                RAISE EXCEPTION 'Established billing adjustment identity cannot change.'
                    USING ERRCODE = '23514';
            END IF;
        ELSIF TG_TABLE_NAME = 'billing_disputes' THEN
            IF OLD.stripe_dispute_id IS NOT NULL
               AND OLD.stripe_dispute_id IS DISTINCT FROM NEW.stripe_dispute_id THEN
                RAISE EXCEPTION 'Established billing adjustment identity cannot change.'
                    USING ERRCODE = '23514';
            END IF;
        ELSE
            RAISE EXCEPTION 'Billing adjustment identity trigger bound to an unexpected table.'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF NEW.payment_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT *
    INTO v_payment
    FROM public.billing_payments
    WHERE id = NEW.payment_id;

    IF NOT FOUND
       OR v_payment.studio_id IS DISTINCT FROM NEW.studio_id
       OR v_payment.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id
       OR v_payment.connect_account_generation IS DISTINCT FROM NEW.connect_account_generation
       OR v_payment.stripe_charge_id IS DISTINCT FROM NEW.stripe_charge_id
       OR v_payment.stripe_payment_intent_id IS DISTINCT FROM NEW.stripe_payment_intent_id THEN
        RAISE EXCEPTION 'Billing adjustment payment identity mismatch.'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.validate_billing_adjustment_payment_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.validate_billing_adjustment_payment_identity()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION private.koaryu_release_adjustment_trigger_guard_manifest_v37()
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_serialized TEXT;
BEGIN
 SELECT pg_get_functiondef(
   'private.validate_billing_adjustment_payment_identity()'::regprocedure
 ) INTO v_serialized;
 RETURN '0:'||encode(extensions.digest(
   convert_to(COALESCE(v_serialized,''),'UTF8'),'sha256'
 ),'hex');
END $$;
ALTER FUNCTION private.koaryu_release_adjustment_trigger_guard_manifest_v37()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_adjustment_trigger_guard_manifest_v37()
    FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE private.koaryu_release_v37_expectations(
 singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
 trigger_guard_manifest TEXT NOT NULL CHECK(trigger_guard_manifest~'^0:[0-9a-f]{64}$')
);
ALTER TABLE private.koaryu_release_v37_expectations OWNER TO postgres;
ALTER TABLE private.koaryu_release_v37_expectations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.koaryu_release_v37_expectations
    FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO private.koaryu_release_v37_expectations VALUES(
 true,'0:414c9c3d38914f4bd3c8498159944e6118716230b3ee5c5c9d99180b7ba177dc'
);

UPDATE private.koaryu_release_v26_expectations
SET expected_sha256='556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136'
WHERE expectation_key='operational_contract_v26';
UPDATE private.koaryu_release_v27_expectations
SET expected_sha256='855d548e95744f3aede9b09986be342a935cef092ccd583e38e2febfba8fe6f6'
WHERE expectation_key='operational_contract_v27';
UPDATE private.koaryu_release_v28_expectations
SET expected_sha256='60fabacbd8f58f14d7ed25764fb6016ef44d6d3dfc926900793f52c1e3d7d13d'
WHERE expectation_key='operational_contract_v28';
UPDATE private.koaryu_release_v29_expectations
SET expected_sha256='32706cfae7047b70ee6b563048ffafa91d945bc824939e3000fa01631a459ecb'
WHERE expectation_key='operational_contract_v29';
UPDATE private.koaryu_release_v30_expectations
SET expected_sha256='2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23'
WHERE expectation_key='operational_contract_v30';
UPDATE private.koaryu_release_v31_expectations
SET expected_sha256='abfd3d70c27d61b7be33193069739ddaef7db8e8a4cc591be1aeeebe130b64cc'
WHERE expectation_key='operational_contract_v31';
UPDATE private.koaryu_release_v31_expectations
SET expected_sha256='c609fd207f20746d6076d49d86a39240021d20122007278d053bcab160cfa2c9'
WHERE expectation_key='resource_ownership_manifest_v31';
UPDATE private.koaryu_release_v31_expectations
SET expected_sha256='43bb07edfbd3c6ee1431b6abda46ca1785b8ea117de2a13f95636fc7a3c3b263'
WHERE expectation_key='operational_manifest_v11';
UPDATE private.koaryu_release_v31_expectations
SET expected_sha256='ba219b8a319d416680ab268ba09c8dad109d4d73db0bfdadedf31318bead365d'
WHERE expectation_key='operational_manifest_v12';

DO $build_v18$
DECLARE v_definition TEXT; v_state TEXT;
BEGIN
 SELECT pg_get_functiondef(
   'public.koaryu_release_schema_preflight_v17()'::regprocedure
 ) INTO v_definition;
 v_definition:=replace(
   v_definition,
   'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v17()',
   'CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v18()'
 );
 v_definition:=replace(
   v_definition,
   'v_count <> 131 OR v_head <> ''20260831054918''',
   'v_count <> 132 OR v_head <> ''20260902001000'''
 );
 v_definition:=replace(v_definition,'migration_history_v36','migration_history_v37');
 v_definition:=replace(
   v_definition,
   '''20260831022021'',''20260831054918''',
   '''20260831022021'',''20260831054918'',''20260902001000'''
 );
 v_definition:=replace(
   v_definition,
   '0:8461239841e35fe5dfd5be685b43c8551a40301f7ac24f1ea5b61a8ab522ce54',
   '0:556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136'
 );
 v_definition:=replace(
   v_definition,
   '4eafa8402fd37c9003a5e0d4bbb961bf344fc4170fac7ad1e1f5bd3b9b55de5c',
   '556935a0c58b3aca9509dd355798100efb1d147830875225fd8464e9a9736136'
 );
 v_definition:=replace(
   v_definition,
   '0:517fefbb5a7f29197599a684d5998a4fd73d0547367e58e67bd59323bc1ed476',
   '0:855d548e95744f3aede9b09986be342a935cef092ccd583e38e2febfba8fe6f6'
 );
 v_definition:=replace(
   v_definition,
   '0:9afa0fc8e7244d43a8fc65724a10fa4ea5c2ef96acd606f38f76960d47b70b02',
   '0:60fabacbd8f58f14d7ed25764fb6016ef44d6d3dfc926900793f52c1e3d7d13d'
 );
 v_definition:=replace(
   v_definition,
   '0:1abbf21f66bcd927d0c1adf1f16255f4d4eebd030b0685f6dd3a2891d5afb5b9',
   '0:32706cfae7047b70ee6b563048ffafa91d945bc824939e3000fa01631a459ecb'
 );
 v_definition:=replace(
   v_definition,
   '0:846135b52d0b7784290b8428b3c1533bc3c1fd47aa5117c009516f640db979d6',
   '0:2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23'
 );
 v_definition:=replace(
   v_definition,
   '846135b52d0b7784290b8428b3c1533bc3c1fd47aa5117c009516f640db979d6',
   '2b57633cdd638418ca7837de9a496755e0a3620f381375657f099f6bcded8c23'
 );
 v_definition:=replace(
   v_definition,
   '0:873f7ac7a8a0d52ffb92de8936f35c1fd2a07c1f52fe20f4b617140fc5fbccae',
   '0:abfd3d70c27d61b7be33193069739ddaef7db8e8a4cc591be1aeeebe130b64cc'
 );
 v_definition:=replace(
   v_definition,
   '0:1e2b5d81df07c4738b195f786427759efd992aa187921b182317e58185c5e566',
   '0:c609fd207f20746d6076d49d86a39240021d20122007278d053bcab160cfa2c9'
 );
 v_definition:=replace(
   v_definition,
   'e0e7bb51715afc4d656260a86a03f897f7f11650cef676f4dd52763daaadec61',
   '43bb07edfbd3c6ee1431b6abda46ca1785b8ea117de2a13f95636fc7a3c3b263'
 );
 v_definition:=replace(
   v_definition,
   '7d55d1237d279a3a9242ccbf4ce814d54fc7eca4348295f0a125f7e8d0c9e627',
   'ba219b8a319d416680ab268ba09c8dad109d4d73db0bfdadedf31318bead365d'
 );
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(
   string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''
 ),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v26_expectations;
 v_definition:=replace(v_definition,
   '1:fb5e52ebe1cf068e8ac0e195852f12d7af2c2226883b37d49e1ddac670e9f66b',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(
   string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''
 ),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v27_expectations;
 v_definition:=replace(v_definition,
   '1:0978554adecf9b75eee1cca4864803a58869a42aea7ac3470110d918b4508723',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(
   string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''
 ),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v28_expectations;
 v_definition:=replace(v_definition,
   '1:169ada27f60344b8127df5c1878572e76e0a6bb027483e7ec23460bdc0147740',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(
   string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''
 ),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v29_expectations;
 v_definition:=replace(v_definition,
   '1:510556b6f40df9ab263f91f9e322baac37b63cfac487aaffd63ee60a16582129',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(
   string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''
 ),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v30_expectations;
 v_definition:=replace(v_definition,
   '1:9ea31cfce65422d038c821449a11f49b826dd20daef71a09906403f1569ccffa',v_state);
 SELECT count(*)::text||':'||encode(extensions.digest(convert_to(coalesce(
   string_agg(expectation_key||':'||expected_sha256,'|' ORDER BY expectation_key COLLATE "C"),''
 ),'UTF8'),'sha256'),'hex') INTO v_state FROM private.koaryu_release_v31_expectations;
 v_definition:=replace(v_definition,
   '1:3d764f9527b71e81235d6ae5dbc62047149958b39b741d63e6600f3d78a4a587',v_state);
 v_definition:=replace(
   v_definition,
   'RETURN QUERY SELECT cardinality(v_failures) = 0,',
   $inject$IF private.koaryu_release_adjustment_trigger_guard_manifest_v37()
      IS DISTINCT FROM (
        SELECT trigger_guard_manifest
        FROM private.koaryu_release_v37_expectations
        WHERE singleton
      ) THEN
     v_failures:=array_append(v_failures,'adjustment_trigger_guard_manifest_v37');
   END IF;
   RETURN QUERY SELECT cardinality(v_failures) = 0,$inject$
 );
 v_definition:=replace(
   v_definition,
   '''release-db-attestation-v36''::TEXT;',
   '''release-db-attestation-v37''::TEXT;'
 );
 EXECUTE v_definition;
END $build_v18$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v18() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v18()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v18()
    TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v17()
RETURNS TABLE(
 ready BOOLEAN,migration_count INTEGER,migration_head TEXT,
 pending_versions TEXT[],security_failures TEXT[],manifest_version TEXT
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $$
DECLARE v RECORD;
BEGIN
 SELECT * INTO v FROM public.koaryu_release_schema_preflight_v18();
 IF v.ready
    AND v.migration_count=132
    AND v.migration_head='20260902001000' THEN
  RETURN QUERY SELECT true,131,'20260831054918'::TEXT,
   v.pending_versions[1:cardinality(v.pending_versions)-1],ARRAY[]::TEXT[],
   'release-db-attestation-v36'::TEXT;
  RETURN;
 END IF;
 RETURN QUERY SELECT false,v.migration_count,v.migration_head,v.pending_versions,
  v.security_failures,'release-db-attestation-v36'::TEXT;
END $$;
ALTER FUNCTION public.koaryu_release_schema_preflight_v17() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v17()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v17()
    TO service_role;

DO $$ BEGIN
 RAISE NOTICE 'KOARYU_V37_TRIGGER_GUARD=%',
  private.koaryu_release_adjustment_trigger_guard_manifest_v37();
 RAISE NOTICE 'KOARYU_V37_CONTRACT_V27=%',
  private.koaryu_release_operational_contract_v27();
 RAISE NOTICE 'KOARYU_V37_CONTRACT_V28=%',
  private.koaryu_release_operational_contract_v28();
 RAISE NOTICE 'KOARYU_V37_CONTRACT_V29=%',
  private.koaryu_release_operational_contract_v29();
 RAISE NOTICE 'KOARYU_V37_CONTRACT_V30=%',
  private.koaryu_release_operational_contract_v30();
 RAISE NOTICE 'KOARYU_V37_CONTRACT_V31=%',
  private.koaryu_release_operational_contract_v31();
 RAISE NOTICE 'KOARYU_V37_RESOURCE_V31=%',
  private.koaryu_release_resource_ownership_manifest_v31();
 RAISE NOTICE 'KOARYU_V37_MANIFEST_V11=%',
  private.koaryu_release_operational_manifest_v11();
 RAISE NOTICE 'KOARYU_V37_MANIFEST_V12=%',
  private.koaryu_release_operational_manifest_v12();
END $$;
