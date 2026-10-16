-- Local disposable contract. Name reconciliation belongs here, not in readiness.
BEGIN;
CREATE TEMP TABLE timezone_checks(label TEXT PRIMARY KEY);
CREATE FUNCTION pg_temp.timezone_check(ok BOOLEAN,label TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF ok IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'timezone contract failed: %',label; END IF;
    INSERT INTO pg_temp.timezone_checks VALUES(label);
END $$;

DO $inventory$
DECLARE signature TEXT; role_name TEXT; denied BOOLEAN; zone TEXT; expected TEXT; value JSONB;
BEGIN
    PERFORM pg_temp.timezone_check(NOT EXISTS(
        (SELECT name FROM private.timezone_names EXCEPT SELECT name FROM pg_catalog.pg_timezone_names)
        UNION ALL
        (SELECT name FROM pg_catalog.pg_timezone_names EXCEPT SELECT name FROM private.timezone_names)),
        'exact live PostgreSQL name inventory');
    PERFORM pg_temp.timezone_check((SELECT relowner='postgres'::REGROLE AND relrowsecurity
        FROM pg_class WHERE oid='private.timezone_names'::REGCLASS),'private reference ownership and RLS');
    FOREACH signature IN ARRAY ARRAY['private.timezone_name_known(text)','private.timezone_name_or_utc(text)'] LOOP
        PERFORM pg_temp.timezone_check((SELECT NOT prosecdef AND provolatile='s'
            AND proowner='postgres'::REGROLE AND proconfig=ARRAY['search_path=pg_catalog']::TEXT[]
            FROM pg_proc WHERE oid=signature::REGPROCEDURE),'safe helper '||signature);
        PERFORM pg_temp.timezone_check(has_function_privilege('service_role',signature,'EXECUTE')
            AND NOT has_function_privilege('anon',signature,'EXECUTE')
            AND NOT has_function_privilege('authenticated',signature,'EXECUTE')
            AND NOT has_function_privilege('public',signature,'EXECUTE'),'helper ACL '||signature);
        FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
            denied:=FALSE;
            BEGIN
                EXECUTE format('SET LOCAL ROLE %I',role_name);
                EXECUTE format('SELECT %s(NULL)',split_part(signature,'(',1));
            EXCEPTION WHEN insufficient_privilege THEN denied:=TRUE;
            END;
            RESET ROLE;
            PERFORM pg_temp.timezone_check(denied,'helper execution denied '||role_name||' '||signature);
        END LOOP;
    END LOOP;
    PERFORM pg_temp.timezone_check(has_table_privilege('service_role','private.timezone_names','SELECT')
        AND NOT has_table_privilege('service_role','private.timezone_names','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT has_table_privilege('anon','private.timezone_names','SELECT,INSERT,UPDATE,DELETE')
        AND NOT has_table_privilege('authenticated','private.timezone_names','SELECT,INSERT,UPDATE,DELETE'),
        'reference read-only service ACL');
    -- Exhaustively compare the lookup predicate for every catalog name, plus the
    -- missing and nullable inputs used by each caller's existing timezone branch.
    PERFORM pg_temp.timezone_check(NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z
        WHERE private.timezone_name_known(z.name) IS DISTINCT FROM TRUE
           OR private.timezone_name_or_utc(z.name) IS DISTINCT FROM z.name),'every known name preserved');
    FOREACH zone IN ARRAY ARRAY['America/Los_Angeles','Unknown/Timezone',NULL] LOOP
        expected:=CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) THEN zone ELSE 'UTC' END;
        PERFORM pg_temp.timezone_check(private.timezone_name_known(zone) IS NOT DISTINCT FROM
            EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone),'known predicate '||coalesce(zone,'NULL'));
        PERFORM pg_temp.timezone_check(private.timezone_name_or_utc(zone) IS NOT DISTINCT FROM expected,
            'UTC fallback '||coalesce(zone,'NULL'));
        IF zone='America/Los_Angeles' THEN
            PERFORM pg_temp.timezone_check(private.automation_timezone_v1(to_jsonb(zone))=zone,'workflow known timezone accepted');
        ELSE
            denied:=FALSE;
            BEGIN
                PERFORM private.automation_timezone_v1(to_jsonb(zone));
            EXCEPTION WHEN SQLSTATE '22023' THEN denied:=(SQLERRM='AUTOMATION_INVALID_REQUEST');
            END;
            PERFORM pg_temp.timezone_check(denied,'workflow rejects '||coalesce(zone,'NULL'));
        END IF;
    END LOOP;
    FOREACH zone IN ARRAY ARRAY['posix/UTC','right/UTC','localtime','posixrules','America/../UTC','UTC ',''] LOOP
        denied:=FALSE;
        BEGIN PERFORM private.automation_timezone_v1(to_jsonb(zone));
        EXCEPTION WHEN SQLSTATE '22023' THEN denied:=(SQLERRM='AUTOMATION_INVALID_REQUEST'); END;
        PERFORM pg_temp.timezone_check(denied,'workflow syntax/namespace rejects '||zone);
    END LOOP;
    denied:=FALSE;
    BEGIN PERFORM private.automation_timezone_v1('null'::JSONB);
    EXCEPTION WHEN SQLSTATE '22023' THEN denied:=(SQLERRM='AUTOMATION_INVALID_REQUEST'); END;
    PERFORM pg_temp.timezone_check(denied,'workflow JSON null rejected');
    -- Enumerate all active rewritten callers; historical migration seed blocks
    -- are immutable and never execute again. Complete definitions/ACLs are pinned
    -- independently by the generated V59 catalog guard.
    FOREACH signature IN ARRAY ARRAY[
        'public.create_studio_onboarding(uuid,text,text,text)',
        'public.dashboard_summary_facts(uuid,text,text,date,text)',
        'public.follow_up_lead_atomic(uuid,uuid,uuid,uuid,jsonb)',
        'public.student_business_date(uuid)',
        'private.missed_class_automation_candidates(uuid,integer,uuid,uuid,timestamp with time zone)',
        'public.preview_missed_class_automation_v1(uuid,uuid,integer)',
        'private.automation_timezone_v1(jsonb)',
        'public.approve_belt_test_recipients_v1(uuid,uuid,uuid,uuid,bigint,jsonb)',
        'private.workflow_current_source_facts_v1(uuid,text,uuid,jsonb,jsonb,timestamp with time zone,text[])',
        'private.workflow_invoice_episode_identity_v1()',
        'private.workflow_finalize_invoice_episodes_v1()',
        'private.workflow_apply_lead_follow_up_v1(uuid,uuid,uuid,text,uuid,jsonb,timestamp with time zone)'
    ] LOOP
        PERFORM pg_temp.timezone_check((SELECT prosrc LIKE '%private.timezone_name_%'
            AND prosrc NOT LIKE '%pg_timezone_names%' FROM pg_proc WHERE oid=signature::REGPROCEDURE),
            'rewritten caller '||signature);
    END LOOP;
    PERFORM pg_temp.timezone_check(NOT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace
        IN ('public'::REGNAMESPACE,'private'::REGNAMESPACE) AND prosrc LIKE '%pg_timezone_names%'),
        'no active application catalog enumeration');
END;
$inventory$;

-- NULL studio zones model legacy/direct-service input. Relax only this
-- disposable transaction's NOT NULL, then roll the complete fixture back.
ALTER TABLE public.studios ALTER COLUMN timezone DROP NOT NULL;
DO $compatibility$
DECLARE old RECORD; current RECORD;
BEGIN
    SELECT * INTO old FROM public.koaryu_release_schema_preflight_v39();
    PERFORM pg_temp.timezone_check(old.ready IS TRUE AND old.migration_count=153
        AND old.migration_head='20261013013243' AND old.manifest_version='release-db-attestation-v58'
        AND old.security_failures=ARRAY[]::TEXT[] AND cardinality(old.pending_versions)=69
        AND old.pending_versions[69]='20261013013243', 'V39 retains V58 success shape after V59');
    GRANT EXECUTE ON FUNCTION private.timezone_name_known(TEXT) TO anon;
    SELECT * INTO old FROM public.koaryu_release_schema_preflight_v39();
    SELECT * INTO current FROM public.koaryu_release_schema_preflight_v40();
    PERFORM pg_temp.timezone_check(old.ready IS FALSE AND current.ready IS FALSE, 'V39 refuses V59 helper ACL drift');
    PERFORM pg_temp.timezone_check(old.security_failures=ARRAY['timezone_functions_v59']::TEXT[]
        AND old.security_failures=current.security_failures, 'V39 preserves exact V59 drift failures');
    PERFORM pg_temp.timezone_check(old.migration_count=154 AND old.migration_head='20261014083106'
        AND old.pending_versions=current.pending_versions AND old.manifest_version='release-db-attestation-v58',
        'V39 drift refusal exposes observed V59 history');
    REVOKE EXECUTE ON FUNCTION private.timezone_name_known(TEXT) FROM anon;
    SELECT * INTO old FROM public.koaryu_release_schema_preflight_v39();
    PERFORM pg_temp.timezone_check(old.ready IS TRUE AND old.migration_count=153
        AND old.migration_head='20261013013243' AND old.security_failures=ARRAY[]::TEXT[], 'V39 success restored after ACL rollback');
END;
$compatibility$;

DO $callers$
DECLARE actor UUID; studio UUID; lead UUID; student UUID; zone TEXT; expected TEXT; result JSONB; reference TIMESTAMPTZ;
    created public.studios; converted public.leads; denied BOOLEAN; candidate RECORD;
BEGIN
    FOREACH zone IN ARRAY ARRAY['America/Los_Angeles','Unknown/Timezone',NULL] LOOP
        actor:=gen_random_uuid(); studio:=gen_random_uuid(); lead:=gen_random_uuid(); student:=gen_random_uuid();
        expected:=CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=zone) THEN zone ELSE 'UTC' END;
        INSERT INTO auth.users(id,email) VALUES(actor,actor||'@example.invalid');
        IF zone IS DISTINCT FROM 'Unknown/Timezone' THEN
            SELECT * INTO created FROM public.create_studio_onboarding(actor,'Timezone onboarding',zone,gen_random_uuid()::TEXT);
            PERFORM pg_temp.timezone_check(created.timezone=coalesce(zone,'America/New_York'),
                'onboarding preserves default '||coalesce(zone,'NULL'));
        ELSE
            denied:=FALSE;
            BEGIN PERFORM public.create_studio_onboarding(actor,'Unknown onboarding',zone,gen_random_uuid()::TEXT);
            EXCEPTION WHEN SQLSTATE '22023' THEN denied:=(SQLERRM='Choose a valid timezone.'); END;
            PERFORM pg_temp.timezone_check(denied,'onboarding unknown rejected');
        END IF;
        actor:=gen_random_uuid();
        INSERT INTO auth.users(id,email) VALUES(actor,actor||'@example.invalid');
        INSERT INTO public.studios(id,name,slug,owner_id,timezone) VALUES(studio,'Timezone fixture',studio::TEXT,actor,zone);
        INSERT INTO public.staff_roles(studio_id,user_id,role) VALUES(studio,actor,'admin');
        INSERT INTO public.studio_subscriptions(studio_id,status,comped) VALUES(studio,'active',false);
        INSERT INTO public.programs(studio_id,name,is_system) VALUES(studio,'Unassigned',true);
        INSERT INTO public.leads(id,studio_id,first_name,last_name,source,stage,is_minor)
            VALUES(lead,studio,'Timezone','Lead','walk_in','inquiry',false);
        SELECT * INTO converted FROM public.follow_up_lead_atomic(studio,actor,lead,gen_random_uuid(),'{"next_stage":"enrolled"}');
        PERFORM pg_temp.timezone_check((SELECT membership_start_date=(CURRENT_TIMESTAMP AT TIME ZONE expected)::DATE
            FROM public.students WHERE id=converted.converted_student_id),'lead conversion date '||coalesce(zone,'NULL'));
        PERFORM pg_temp.timezone_check(public.student_business_date(studio)=(CURRENT_TIMESTAMP AT TIME ZONE expected)::DATE,
            'student business date '||coalesce(zone,'NULL'));
        result:=public.dashboard_summary_facts(studio,'billing_hidden',zone,DATE '2026-10-14','dashboard-summary-v1');
        PERFORM pg_temp.timezone_check(result->>'timezone'=expected AND result#>>'{studio,timezone}'=expected,
            'dashboard fallback '||coalesce(zone,'NULL'));
        INSERT INTO public.students(id,studio_id,legal_first_name,legal_last_name,status,is_minor,email)
            VALUES(student,studio,'Timezone','Student','active',false,'timezone.'||student||'@example.invalid');
        reference:=TIMESTAMPTZ '2026-10-14 01:00:00+00';
        SELECT * INTO candidate FROM private.missed_class_automation_candidates(studio,14,student,NULL,reference);
        PERFORM pg_temp.timezone_check(candidate.student_id=student AND candidate.reference_date=(reference AT TIME ZONE expected)::DATE,
            'missed-class candidate date '||coalesce(zone,'NULL'));
        result:=public.preview_missed_class_automation_v1(studio,actor,14);
        PERFORM pg_temp.timezone_check((result->>'reference_date')::DATE=(clock_timestamp() AT TIME ZONE expected)::DATE,
            'missed-class preview date '||coalesce(zone,'NULL'));
    END LOOP;
END;
$callers$;
SELECT count(*) AS timezone_contract_assertions FROM pg_temp.timezone_checks;
ROLLBACK;
