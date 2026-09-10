-- Atomic local plan persistence; no historical data backfill.
-- Register this migration in the same transaction.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v24()')),'UTF8'),'sha256'),'hex')
        IS DISTINCT FROM '123158c0eb3fa8fda75b0b45316f1604835958d3d4ee25d480f4d27b3316de81' THEN
        RAISE EXCEPTION 'V44 requires the reviewed full V43 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v24();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 138
       OR v.migration_head IS DISTINCT FROM '20260910093958'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v43'
       OR cardinality(v.security_failures) IS DISTINCT FROM 0
       OR cardinality(v.pending_versions) IS DISTINCT FROM 54
       OR v.pending_versions[54] IS DISTINCT FROM '20260910093958' THEN
        RAISE EXCEPTION 'V44 requires a fully verified V43 predecessor.';
    END IF;
    IF encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('public.clear_studio_operational_data_atomic(uuid,boolean)')),'UTF8'),'sha256'),'hex')
        IS DISTINCT FROM '8723f971d9129068221ddb9d7a34ae86addaf5f9cc14218084e750641d9a9679' THEN
        RAISE EXCEPTION 'V44 requires the reviewed operational-clear definition.';
    END IF;
END;
$predecessor$;

CREATE FUNCTION public.write_billing_plan_v1(
    p_studio_id UUID,
    p_actor_id UUID,
    p_plan_id UUID,
    p_values JSONB,
    p_program_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
    v_fields CONSTANT TEXT[] := ARRAY['name','description','amount_cents','currency','billing_interval',
        'signup_fee_cents','trial_days','proration_behavior','freeze_behavior','cancellation_policy','tax_behavior'];
    v_required CONSTANT TEXT[] := ARRAY['name','amount_cents','currency','billing_interval',
        'signup_fee_cents','trial_days','proration_behavior'];
    v_numbers CONSTANT TEXT[] := ARRAY['amount_cents','signup_fee_cents','trial_days'];
    v_create BOOLEAN := p_plan_id IS NULL;
    v_old public.billing_plans%ROWTYPE;
    v_plan public.billing_plans%ROWTYPE;
    v_values JSONB;
    v_old_ids UUID[] := ARRAY[]::UUID[];
    v_ids UUID[];
    v_found INTEGER;
    v_key TEXT;
    v_value JSONB;
    v_changes JSONB := '{}'::JSONB;
    v_programs_changed BOOLEAN;
    v_provider_changed BOOLEAN;
    v_financial_changed BOOLEAN;
    v_programs JSONB;
BEGIN
    IF p_studio_id IS NULL OR p_actor_id IS NULL OR p_values IS NULL
       OR jsonb_typeof(p_values) IS DISTINCT FROM 'object'
       OR array_position(p_program_ids, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'billing_plan_invalid_request' USING ERRCODE = '22023';
    END IF;
    FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_values) LOOP
        IF NOT (v_key = ANY(v_fields))
           OR (v_key = ANY(v_required) AND v_value = 'null'::JSONB)
           OR (v_key = ANY(v_numbers) AND jsonb_typeof(v_value) IS DISTINCT FROM 'number')
           OR (NOT (v_key = ANY(v_numbers)) AND jsonb_typeof(v_value) NOT IN ('string','null')) THEN
            RAISE EXCEPTION 'billing_plan_invalid_request' USING ERRCODE = '22023';
        END IF;
    END LOOP;
    IF (v_create AND (NOT (p_values ? 'name') OR NOT (p_values ? 'amount_cents')))
       OR (p_values ? 'name' AND (char_length(p_values->>'name') > 140
           OR (p_values->>'name') !~ '[^[:space:]]')) THEN
        RAISE EXCEPTION 'billing_plan_invalid_request' USING ERRCODE = '22023';
    END IF;

    -- Both this command and guarded demo clear take their advisory lock first.
    -- Shared locks allow ordinary plan writes to proceed independently.
    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended('koaryu.local-plan-clear:' || p_studio_id::TEXT, 0));
    PERFORM 1 FROM public.studios WHERE id = p_studio_id FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'billing_plan_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.staff_roles
        WHERE studio_id = p_studio_id AND user_id = p_actor_id
          AND role = 'admin' AND archived_at IS NULL) THEN
        RAISE EXCEPTION 'billing_plan_actor_not_active' USING ERRCODE = '42501';
    END IF;

    IF v_create THEN
        v_values := '{"description":null,"currency":"usd","billing_interval":"monthly",
            "signup_fee_cents":0,"trial_days":0,"proration_behavior":"next_cycle",
            "freeze_behavior":null,"cancellation_policy":null,"tax_behavior":null}'::JSONB || p_values;
    ELSE
        SELECT * INTO v_old FROM public.billing_plans
        WHERE id = p_plan_id AND studio_id = p_studio_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'billing_plan_not_found' USING ERRCODE = 'P0002';
        END IF;
        v_values := p_values;
        SELECT COALESCE(array_agg(program_id ORDER BY program_id), ARRAY[]::UUID[])
        INTO v_old_ids FROM public.billing_plan_programs
        WHERE studio_id = p_studio_id AND billing_plan_id = p_plan_id;
    END IF;
    BEGIN
        v_plan := jsonb_populate_record(v_old, v_values);
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'billing_plan_invalid_request' USING ERRCODE = '22023';
    END;
    IF v_create THEN
        v_plan.currency := lower(btrim(v_plan.currency));
    ELSIF lower(btrim(v_plan.currency)) = lower(btrim(v_old.currency)) THEN
        -- Equivalent spelling must not rewrite a historical currency or disable its price.
        v_plan.currency := v_old.currency;
    ELSE
        v_plan.currency := lower(btrim(v_plan.currency));
    END IF;
    v_financial_changed := v_create OR ROW(v_plan.amount_cents, v_plan.currency, v_plan.billing_interval,
        v_plan.signup_fee_cents, v_plan.trial_days) IS DISTINCT FROM
        ROW(v_old.amount_cents, v_old.currency, v_old.billing_interval, v_old.signup_fee_cents, v_old.trial_days);
    IF v_financial_changed AND lower(btrim(v_plan.currency)) IS DISTINCT FROM 'usd' THEN
        RAISE EXCEPTION 'billing_plan_requires_usd' USING ERRCODE = '22023';
    END IF;

    IF p_program_ids IS NULL AND NOT v_create THEN
        v_ids := v_old_ids;
    ELSE
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::UUID[]) INTO v_ids
        FROM (SELECT DISTINCT unnest(COALESCE(p_program_ids, ARRAY[]::UUID[])) AS id) AS requested;
    END IF;
    IF cardinality(v_ids) > 0 THEN
        PERFORM program.id FROM public.programs AS program
        WHERE program.studio_id = p_studio_id AND program.id = ANY(v_ids)
        ORDER BY program.id FOR SHARE OF program;
        GET DIAGNOSTICS v_found = ROW_COUNT;
        IF v_found <> cardinality(v_ids) THEN
            RAISE EXCEPTION 'billing_plan_program_not_found' USING ERRCODE = 'P0002';
        END IF;
    END IF;
    v_programs_changed := v_ids IS DISTINCT FROM v_old_ids;

    IF v_create THEN
        INSERT INTO public.billing_plans (studio_id, name, description, amount_cents, currency,
            billing_interval, signup_fee_cents, trial_days, proration_behavior,
            freeze_behavior, cancellation_policy, tax_behavior)
        VALUES (p_studio_id, v_plan.name, v_plan.description, v_plan.amount_cents, v_plan.currency,
            v_plan.billing_interval, v_plan.signup_fee_cents, v_plan.trial_days, v_plan.proration_behavior,
            v_plan.freeze_behavior, v_plan.cancellation_policy, v_plan.tax_behavior)
        RETURNING * INTO v_plan;
    ELSE
        SELECT COALESCE(jsonb_object_agg(key, value), '{}'::JSONB) INTO v_changes
        FROM jsonb_each(to_jsonb(v_plan))
        WHERE key = ANY(v_fields) AND value IS DISTINCT FROM to_jsonb(v_old)->key;
        v_provider_changed := ROW(v_plan.amount_cents, v_plan.currency, v_plan.billing_interval,
            v_plan.name, v_plan.description) IS DISTINCT FROM
            ROW(v_old.amount_cents, v_old.currency, v_old.billing_interval, v_old.name, v_old.description);
        IF v_provider_changed AND v_old.status <> 'archived' AND v_old.archived_at IS NULL THEN
            v_plan.status := 'pending';
            IF v_plan.status IS DISTINCT FROM v_old.status THEN
                v_changes := v_changes || jsonb_build_object('status', v_plan.status);
            END IF;
        END IF;
        IF v_changes <> '{}'::JSONB THEN
            UPDATE public.billing_plans SET
                name = v_plan.name, description = v_plan.description, amount_cents = v_plan.amount_cents,
                currency = v_plan.currency, billing_interval = v_plan.billing_interval,
                signup_fee_cents = v_plan.signup_fee_cents, trial_days = v_plan.trial_days,
                proration_behavior = v_plan.proration_behavior, freeze_behavior = v_plan.freeze_behavior,
                cancellation_policy = v_plan.cancellation_policy, tax_behavior = v_plan.tax_behavior,
                status = v_plan.status
            WHERE id = p_plan_id AND studio_id = p_studio_id
            RETURNING * INTO v_plan;
        END IF;
    END IF;
    IF v_programs_changed THEN
        DELETE FROM public.billing_plan_programs
        WHERE studio_id = p_studio_id AND billing_plan_id = v_plan.id AND NOT (program_id = ANY(v_ids));
        INSERT INTO public.billing_plan_programs (studio_id, billing_plan_id, program_id)
        SELECT p_studio_id, v_plan.id, requested.id FROM unnest(v_ids) AS requested(id)
        WHERE NOT EXISTS (SELECT 1 FROM public.billing_plan_programs AS link
            WHERE link.studio_id = p_studio_id AND link.billing_plan_id = v_plan.id AND link.program_id = requested.id);
    END IF;
    IF v_create OR v_changes <> '{}'::JSONB OR v_programs_changed THEN
        INSERT INTO public.audit_logs (studio_id, actor_id, action, entity_type, entity_id, metadata)
        VALUES (p_studio_id, p_actor_id,
            CASE WHEN v_create THEN 'billing.plan_created' ELSE 'billing.plan_updated' END,
            'billing', v_plan.id,
            CASE WHEN v_create THEN jsonb_build_object('name', v_plan.name, 'program_ids', v_ids)
                ELSE jsonb_build_object('changes', v_changes,
                    'program_ids', CASE WHEN v_programs_changed THEN to_jsonb(v_ids) ELSE 'null'::JSONB END) END);
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'program_id', program.id, 'program_name', program.name, 'program_color_hex', program.color_hex)
        ORDER BY program.sort_order, program.id), '[]'::JSONB)
    INTO v_programs FROM public.billing_plan_programs AS link
    JOIN public.programs AS program ON program.id = link.program_id AND program.studio_id = p_studio_id
    WHERE link.studio_id = p_studio_id AND link.billing_plan_id = v_plan.id;
    RETURN jsonb_build_object('plan', to_jsonb(v_plan), 'programs', v_programs);
END;
$function$;
ALTER FUNCTION public.write_billing_plan_v1(UUID, UUID, UUID, JSONB, UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.write_billing_plan_v1(UUID, UUID, UUID, JSONB, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_billing_plan_v1(UUID, UUID, UUID, JSONB, UUID[]) TO service_role;

CREATE OR REPLACE FUNCTION public.clear_studio_operational_data_atomic(
    p_studio_id UUID,
    p_include_platform_rows BOOLEAN DEFAULT FALSE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_student_ids UUID[];
    v_guardian_ids UUID[];
BEGIN
    IF p_studio_id IS NULL THEN
        RAISE EXCEPTION 'Studio operational clear requires a studio id.'
            USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('koaryu.local-plan-clear:' || p_studio_id::TEXT, 0));

    PERFORM 1
      FROM public.studios
     WHERE id = p_studio_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Studio not found for operational clear.'
            USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
      INTO v_student_ids
      FROM public.students
     WHERE studio_id = p_studio_id;

    SELECT COALESCE(array_agg(id), ARRAY[]::UUID[])
      INTO v_guardian_ids
      FROM public.guardians
     WHERE studio_id = p_studio_id;

    IF to_regclass('public.billing_disputes') IS NOT NULL THEN
        DELETE FROM public.billing_disputes WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_refunds') IS NOT NULL THEN
        DELETE FROM public.billing_refunds WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_payments') IS NOT NULL THEN
        DELETE FROM public.billing_payments WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_invoice_items') IS NOT NULL THEN
        DELETE FROM public.billing_invoice_items WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_invoices') IS NOT NULL THEN
        DELETE FROM public.billing_invoices WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.student_billing_enrollments') IS NOT NULL THEN
        DELETE FROM public.student_billing_enrollments WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_subscriptions') IS NOT NULL THEN
        DELETE FROM public.billing_subscriptions WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plan_programs') IS NOT NULL THEN
        DELETE FROM public.billing_plan_programs WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plan_prices') IS NOT NULL THEN
        DELETE FROM public.billing_plan_prices WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_plans') IS NOT NULL THEN
        DELETE FROM public.billing_plans WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.billing_payers') IS NOT NULL THEN
        DELETE FROM public.billing_payers WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.email_usage_events') IS NOT NULL THEN
        DELETE FROM public.email_usage_events WHERE studio_id = p_studio_id;
    END IF;
    IF to_regclass('public.export_jobs') IS NOT NULL THEN
        DELETE FROM public.export_jobs WHERE studio_id = p_studio_id;
    END IF;

    IF p_include_platform_rows THEN
        IF to_regclass('public.studio_payment_accounts') IS NOT NULL THEN
            DELETE FROM public.studio_payment_accounts WHERE studio_id = p_studio_id;
        END IF;
        IF to_regclass('public.studio_subscriptions') IS NOT NULL THEN
            DELETE FROM public.studio_subscriptions WHERE studio_id = p_studio_id;
        END IF;
    END IF;

    DELETE FROM public.attendance WHERE studio_id = p_studio_id;
    DELETE FROM public.promotions WHERE studio_id = p_studio_id;

    IF to_regclass('public.student_program_memberships') IS NOT NULL THEN
        DELETE FROM public.student_program_memberships WHERE studio_id = p_studio_id;
    END IF;

    DELETE FROM public.lead_activities WHERE studio_id = p_studio_id;
    DELETE FROM public.student_import_runs WHERE studio_id = p_studio_id;
    DELETE FROM public.leads WHERE studio_id = p_studio_id;

    IF cardinality(v_student_ids) > 0 THEN
        DELETE FROM public.student_guardians WHERE student_id = ANY(v_student_ids);
    END IF;
    IF cardinality(v_guardian_ids) > 0 THEN
        DELETE FROM public.student_guardians WHERE guardian_id = ANY(v_guardian_ids);
    END IF;

    DELETE FROM public.class_sessions WHERE studio_id = p_studio_id;
    DELETE FROM public.class_templates WHERE studio_id = p_studio_id;
    DELETE FROM public.students WHERE studio_id = p_studio_id;
    DELETE FROM public.guardians WHERE studio_id = p_studio_id;
    DELETE FROM public.belt_ranks WHERE studio_id = p_studio_id;
    DELETE FROM public.belt_ladders WHERE studio_id = p_studio_id;
    DELETE FROM public.programs WHERE studio_id = p_studio_id;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_studio_operational_data_atomic(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_studio_operational_data_atomic(UUID, BOOLEAN) TO service_role;

CREATE FUNCTION public.koaryu_release_schema_preflight_v25()
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
    IF v_count <> 139 OR v_head <> '20260910135133' THEN
        v_failures := array_append(v_failures, 'migration_history_v44');
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
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231','20260910093958','20260910135133'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v31');
        v_failures := array_append(v_failures, 'migration_history_sequence_v30');
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31()
       IS DISTINCT FROM '0:49fb66b782a732d495428e62c88ae227f32ef4c22be6d41a4cac0ff686f81e48' THEN
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
       IS DISTINCT FROM '9f3190acf304988b74da920b85a8e1cdb6a62eb8615017788b057b477667e5a2' THEN
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
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v44'::TEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v24()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v25();
    IF v.ready IS TRUE AND v.migration_count = 139 AND v.migration_head = '20260910135133'
       AND v.manifest_version = 'release-db-attestation-v44'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 55
       AND v.pending_versions[cardinality(v.pending_versions)] = '20260910135133' THEN
        RETURN QUERY SELECT TRUE, 138, '20260910093958'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v43'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v43'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v25() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v25() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v25() TO service_role;

ALTER FUNCTION public.koaryu_release_schema_preflight_v24() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v24() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v24() TO service_role;

DO $installed$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v25();
    IF v.migration_count IS DISTINCT FROM 138 OR v.migration_head IS DISTINCT FROM '20260910093958'
       OR v.security_failures IS DISTINCT FROM ARRAY['migration_history_v44',
           'migration_history_sequence_v31','migration_history_sequence_v30']::TEXT[] THEN
        RAISE EXCEPTION 'V44 installed contracts did not verify before history registration: %', row_to_json(v);
    END IF;
END;
$installed$;
