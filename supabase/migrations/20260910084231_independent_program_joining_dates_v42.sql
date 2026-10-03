-- Keep retained program dates independent of overall student joining dates.
-- No business-row backfill. Register this migration in the same transaction.
DO $predecessor$
DECLARE v RECORD;
BEGIN
    IF encode(extensions.digest(convert_to(pg_catalog.pg_get_functiondef(
        pg_catalog.to_regprocedure('public.koaryu_release_schema_preflight_v22()')),'UTF8'),'sha256'),'hex')
        IS DISTINCT FROM 'fd2cdf936efa46af88f1c89302bcb747a829b4ecc982e3e801016e55581b7615' THEN
        RAISE EXCEPTION 'V42 requires the reviewed full V41 readiness definition.';
    END IF;
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v22();
    IF v.ready IS DISTINCT FROM TRUE OR v.migration_count IS DISTINCT FROM 136
       OR v.migration_head IS DISTINCT FROM '20260908183744'
       OR v.manifest_version IS DISTINCT FROM 'release-db-attestation-v41'
       OR cardinality(v.security_failures) IS DISTINCT FROM 0
       OR cardinality(v.pending_versions) IS DISTINCT FROM 52
       OR v.pending_versions[52] IS DISTINCT FROM '20260908183744' THEN
        RAISE EXCEPTION 'V42 requires a fully verified V41 predecessor.';
    END IF;
END;
$predecessor$;

CREATE OR REPLACE FUNCTION private.write_student_profile_atomic(
    p_student_id UUID,
    p_studio_id UUID,
    p_actor_id UUID,
    p_student JSONB,
    p_program_ids UUID[] DEFAULT NULL,
    p_guardians JSONB DEFAULT '[]'::JSONB,
    p_replace_programs BOOLEAN DEFAULT FALSE,
    p_audit_action TEXT DEFAULT 'student.updated'
)
RETURNS public.students
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_existing public.students%ROWTYPE;
    v_updated public.students%ROWTYPE;
    v_program_ids UUID[] := COALESCE(p_program_ids, ARRAY[]::UUID[]);
    v_program_id UUID;
    v_rank_program_id UUID;
    v_membership_id UUID;
    v_current_belt_rank_id UUID;
    v_membership_started_at DATE;
    v_today DATE := CURRENT_DATE;
    v_tags TEXT[];
    v_guardian JSONB;
    v_guardian_row public.guardians%ROWTYPE;
    v_guardian_first_name TEXT;
    v_guardian_last_name TEXT;
BEGIN
    IF p_student IS NULL OR jsonb_typeof(p_student) <> 'object' THEN
        RAISE EXCEPTION 'Student write payload must be a JSON object.'
            USING ERRCODE = '22023';
    END IF;

    IF p_student_id IS NULL THEN
        RAISE EXCEPTION 'Student write requires a student id.'
            USING ERRCODE = '22023';
    END IF;

    IF p_student ? 'studio_id' AND NULLIF(p_student->>'studio_id', '')::UUID IS DISTINCT FROM p_studio_id THEN
        RAISE EXCEPTION 'Student write payload studio does not match request studio.'
            USING ERRCODE = 'P0001';
    END IF;

    IF p_replace_programs THEN
        IF cardinality(v_program_ids) IS NULL OR cardinality(v_program_ids) = 0 THEN
            RAISE EXCEPTION 'Student write requires program memberships.'
                USING ERRCODE = '22023';
        END IF;

        FOREACH v_program_id IN ARRAY v_program_ids LOOP
            IF v_program_id IS NULL THEN
                RAISE EXCEPTION 'Student write includes an empty program id.'
                    USING ERRCODE = '22023';
            END IF;

            PERFORM 1
              FROM public.programs
             WHERE id = v_program_id
               AND studio_id = p_studio_id
               AND archived_at IS NULL;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Student write program does not belong to this studio or is archived.'
                    USING ERRCODE = 'P0001';
            END IF;
        END LOOP;
    END IF;

    IF p_student ? 'tags' THEN
        SELECT COALESCE(array_agg(tag.value), ARRAY[]::TEXT[])
          INTO v_tags
          FROM jsonb_array_elements_text(
              CASE
                  WHEN jsonb_typeof(p_student->'tags') = 'array' THEN p_student->'tags'
                  ELSE '[]'::JSONB
              END
          ) AS tag(value);
    END IF;

    SELECT *
      INTO v_existing
      FROM public.students
     WHERE id = p_student_id
     FOR UPDATE;

    IF FOUND AND v_existing.studio_id <> p_studio_id THEN
        RAISE EXCEPTION 'Student id already belongs to another studio.'
            USING ERRCODE = 'P0001';
    END IF;

    IF NOT FOUND THEN
        IF p_audit_action <> 'student.created' THEN
            RAISE EXCEPTION 'Student not found for update.'
                USING ERRCODE = 'P0001';
        END IF;

        IF NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), '') IS NULL
           OR NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Student create payload is missing required name fields.'
                USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.students (
            id,
            studio_id,
            legal_first_name,
            legal_last_name,
            preferred_name,
            date_of_birth,
            is_minor,
            email,
            phone,
            address_line1,
            address_city,
            address_state,
            address_zip,
            emergency_contact_name,
            emergency_contact_phone,
            emergency_contact_relation,
            status,
            membership_start_date,
            program_id,
            current_belt_rank_id,
            notes,
            tags,
            hold_start_date,
            hold_end_date
        )
        VALUES (
            p_student_id,
            p_studio_id,
            NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), ''),
            NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), ''),
            NULLIF(p_student->>'preferred_name', ''),
            NULLIF(p_student->>'date_of_birth', '')::DATE,
            COALESCE((p_student->>'is_minor')::BOOLEAN, false),
            NULLIF(p_student->>'email', ''),
            NULLIF(p_student->>'phone', ''),
            NULLIF(p_student->>'address_line1', ''),
            NULLIF(p_student->>'address_city', ''),
            NULLIF(p_student->>'address_state', ''),
            NULLIF(p_student->>'address_zip', ''),
            NULLIF(p_student->>'emergency_contact_name', ''),
            NULLIF(p_student->>'emergency_contact_phone', ''),
            NULLIF(p_student->>'emergency_contact_relation', ''),
            COALESCE(NULLIF(p_student->>'status', ''), 'active'),
            NULLIF(p_student->>'membership_start_date', '')::DATE,
            CASE WHEN p_replace_programs THEN v_program_ids[1] ELSE NULLIF(p_student->>'program_id', '')::UUID END,
            NULLIF(p_student->>'current_belt_rank_id', '')::UUID,
            NULLIF(p_student->>'notes', ''),
            COALESCE(v_tags, ARRAY[]::TEXT[]),
            NULLIF(p_student->>'hold_start_date', '')::DATE,
            NULLIF(p_student->>'hold_end_date', '')::DATE
        )
        RETURNING * INTO v_updated;
    ELSE
        UPDATE public.students
           SET legal_first_name = CASE WHEN p_student ? 'legal_first_name' THEN NULLIF(btrim(COALESCE(p_student->>'legal_first_name', '')), '') ELSE legal_first_name END,
               legal_last_name = CASE WHEN p_student ? 'legal_last_name' THEN NULLIF(btrim(COALESCE(p_student->>'legal_last_name', '')), '') ELSE legal_last_name END,
               preferred_name = CASE WHEN p_student ? 'preferred_name' THEN NULLIF(p_student->>'preferred_name', '') ELSE preferred_name END,
               date_of_birth = CASE WHEN p_student ? 'date_of_birth' THEN NULLIF(p_student->>'date_of_birth', '')::DATE ELSE date_of_birth END,
               is_minor = CASE WHEN p_student ? 'is_minor' THEN COALESCE((p_student->>'is_minor')::BOOLEAN, false) ELSE is_minor END,
               email = CASE WHEN p_student ? 'email' THEN NULLIF(p_student->>'email', '') ELSE email END,
               phone = CASE WHEN p_student ? 'phone' THEN NULLIF(p_student->>'phone', '') ELSE phone END,
               address_line1 = CASE WHEN p_student ? 'address_line1' THEN NULLIF(p_student->>'address_line1', '') ELSE address_line1 END,
               address_city = CASE WHEN p_student ? 'address_city' THEN NULLIF(p_student->>'address_city', '') ELSE address_city END,
               address_state = CASE WHEN p_student ? 'address_state' THEN NULLIF(p_student->>'address_state', '') ELSE address_state END,
               address_zip = CASE WHEN p_student ? 'address_zip' THEN NULLIF(p_student->>'address_zip', '') ELSE address_zip END,
               emergency_contact_name = CASE WHEN p_student ? 'emergency_contact_name' THEN NULLIF(p_student->>'emergency_contact_name', '') ELSE emergency_contact_name END,
               emergency_contact_phone = CASE WHEN p_student ? 'emergency_contact_phone' THEN NULLIF(p_student->>'emergency_contact_phone', '') ELSE emergency_contact_phone END,
               emergency_contact_relation = CASE WHEN p_student ? 'emergency_contact_relation' THEN NULLIF(p_student->>'emergency_contact_relation', '') ELSE emergency_contact_relation END,
               status = CASE WHEN p_student ? 'status' THEN COALESCE(NULLIF(p_student->>'status', ''), status) ELSE status END,
               membership_start_date = CASE WHEN p_student ? 'membership_start_date' THEN NULLIF(p_student->>'membership_start_date', '')::DATE ELSE membership_start_date END,
               program_id = CASE WHEN p_replace_programs THEN v_program_ids[1] WHEN p_student ? 'program_id' THEN NULLIF(p_student->>'program_id', '')::UUID ELSE program_id END,
               current_belt_rank_id = CASE WHEN p_student ? 'current_belt_rank_id' THEN NULLIF(p_student->>'current_belt_rank_id', '')::UUID ELSE current_belt_rank_id END,
               notes = CASE WHEN p_student ? 'notes' THEN NULLIF(p_student->>'notes', '') ELSE notes END,
               tags = CASE WHEN p_student ? 'tags' THEN COALESCE(v_tags, ARRAY[]::TEXT[]) ELSE tags END,
               hold_start_date = CASE WHEN p_student ? 'hold_start_date' THEN NULLIF(p_student->>'hold_start_date', '')::DATE ELSE hold_start_date END,
               hold_end_date = CASE WHEN p_student ? 'hold_end_date' THEN NULLIF(p_student->>'hold_end_date', '')::DATE ELSE hold_end_date END
         WHERE id = p_student_id
           AND studio_id = p_studio_id
         RETURNING * INTO v_updated;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Student not found for update.'
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    IF p_replace_programs THEN
        v_current_belt_rank_id := v_updated.current_belt_rank_id;
        v_membership_started_at := v_updated.membership_start_date;

        IF v_current_belt_rank_id IS NOT NULL THEN
            SELECT ladder.program_id
              INTO v_rank_program_id
              FROM public.belt_ranks AS belt_rank
              JOIN public.belt_ladders AS ladder ON ladder.id = belt_rank.ladder_id
             WHERE belt_rank.id = v_current_belt_rank_id
               AND belt_rank.studio_id = p_studio_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Current belt rank does not belong to this studio.'
                    USING ERRCODE = 'P0001';
            END IF;
        END IF;

        UPDATE public.student_program_memberships AS membership
           SET status = 'ended',
               ended_at = v_today,
               current_belt_rank_id = NULL
         WHERE membership.student_id = p_student_id
           AND membership.studio_id = p_studio_id
           AND membership.ended_at IS NULL
           AND NOT (membership.program_id = ANY(v_program_ids));

        FOREACH v_program_id IN ARRAY v_program_ids LOOP
            SELECT membership.id
              INTO v_membership_id
              FROM public.student_program_memberships AS membership
             WHERE membership.student_id = p_student_id
               AND membership.studio_id = p_studio_id
               AND membership.program_id = v_program_id
               AND membership.ended_at IS NULL
             FOR UPDATE;

            IF FOUND THEN
                UPDATE public.student_program_memberships AS membership
                   SET status = CASE WHEN membership.status = 'paused' THEN 'paused' ELSE 'active' END,
                       ended_at = NULL,
                       current_belt_rank_id = CASE
                           WHEN v_current_belt_rank_id IS NOT NULL
                                AND (v_rank_program_id IS NULL OR v_rank_program_id = v_program_id)
                           THEN v_current_belt_rank_id
                           ELSE NULL
                       END
                 WHERE membership.id = v_membership_id
                   AND membership.studio_id = p_studio_id;
            ELSE
                INSERT INTO public.student_program_memberships (
                    studio_id,
                    student_id,
                    program_id,
                    status,
                    started_at,
                    current_belt_rank_id
                )
                VALUES (
                    p_studio_id,
                    p_student_id,
                    v_program_id,
                    'active',
                    v_membership_started_at,
                    CASE
                        WHEN v_current_belt_rank_id IS NOT NULL
                             AND (v_rank_program_id IS NULL OR v_rank_program_id = v_program_id)
                        THEN v_current_belt_rank_id
                        ELSE NULL
                    END
                );
            END IF;
        END LOOP;
    END IF;

    IF jsonb_typeof(p_guardians) = 'array' THEN
        FOR v_guardian IN SELECT value FROM jsonb_array_elements(p_guardians)
        LOOP
            v_guardian_first_name := NULLIF(btrim(COALESCE(v_guardian->>'first_name', '')), '');
            v_guardian_last_name := NULLIF(btrim(COALESCE(v_guardian->>'last_name', '')), '');
            IF v_guardian_first_name IS NULL OR v_guardian_last_name IS NULL THEN
                RAISE EXCEPTION 'Guardian create payload is missing required name fields.'
                    USING ERRCODE = '22023';
            END IF;

            INSERT INTO public.guardians (
                studio_id,
                first_name,
                last_name,
                email,
                phone,
                relation,
                is_primary_contact
            )
            VALUES (
                p_studio_id,
                v_guardian_first_name,
                v_guardian_last_name,
                NULLIF(v_guardian->>'email', ''),
                NULLIF(v_guardian->>'phone', ''),
                NULLIF(v_guardian->>'relation', ''),
                COALESCE((v_guardian->>'is_primary_contact')::BOOLEAN, false)
            )
            RETURNING * INTO v_guardian_row;

            INSERT INTO public.student_guardians (
                student_id,
                guardian_id
            )
            VALUES (
                p_student_id,
                v_guardian_row.id
            );
        END LOOP;
    ELSIF p_guardians IS NOT NULL THEN
        RAISE EXCEPTION 'Student guardians payload must be an array.'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.audit_logs (
        studio_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        metadata
    )
    VALUES (
        p_studio_id,
        p_actor_id,
        p_audit_action,
        'student',
        p_student_id,
        CASE
            WHEN p_audit_action = 'student.created' THEN
                jsonb_build_object('name', concat_ws(' ', v_updated.legal_first_name, v_updated.legal_last_name))
            ELSE
                p_student
        END
    );

    RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION private.write_student_profile_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.write_student_profile_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION private.koaryu_release_student_rank_writer_manifest_v13()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
WITH required_functions(signature, expected_result) AS (
    VALUES
        (
            'public.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'students'
        ),
        (
            'private.write_student_profile_atomic(uuid, uuid, uuid, jsonb, uuid[], jsonb, boolean, text)',
            'students'
        ),
        (
            'public.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'TABLE(student_id uuid, guardian_imported boolean)'
        ),
        (
            'private.import_student_row_atomic(jsonb, uuid, uuid, text, integer, text, text, text, text, uuid[])',
            'TABLE(student_id uuid, guardian_imported boolean)'
        )
),
function_actual AS (
    SELECT
        format(
            '%I.%I(%s)',
            namespace.nspname,
            function.proname,
            oidvectortypes(function.proargtypes)
        ) AS signature,
        replace(pg_get_function_result(function.oid), 'public.', '') AS result_contract
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN required_functions required
      ON required.signature = format(
          '%I.%I(%s)',
          namespace.nspname,
          function.proname,
          oidvectortypes(function.proargtypes)
      )
),
function_compared AS (
    SELECT
        required.signature,
        required.expected_result,
        actual.result_contract
    FROM required_functions required
    LEFT JOIN function_actual actual USING (signature)
),
manifest_state AS (
    SELECT private.koaryu_release_student_rank_writer_manifest_v11() AS v11_manifest
),
invalid AS (
    SELECT
        count(*) FILTER (
            WHERE function.result_contract IS DISTINCT FROM function.expected_result
        ) +
        count(*) FILTER (
            WHERE manifest.v11_manifest IS DISTINCT FROM
              '0:055e856b82b43d1f62bc4e910bf58eae2de10272ebe22164d124e7f39598e54b'
        ) AS invalid_count
    FROM function_compared function
    CROSS JOIN manifest_state manifest
)
SELECT invalid.invalid_count::TEXT || ':' || encode(
    extensions.digest(
        convert_to(
            manifest.v11_manifest || '|' || COALESCE(string_agg(
                function.signature || ':' ||
                function.expected_result || ':' ||
                COALESCE(function.result_contract, ''),
                '|' ORDER BY function.signature COLLATE "C"
            ), ''),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
FROM function_compared function
CROSS JOIN manifest_state manifest
CROSS JOIN invalid
GROUP BY invalid.invalid_count, manifest.v11_manifest;
$function$
;
ALTER FUNCTION private.write_student_profile_atomic(UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT) OWNER TO postgres;
ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v13() FROM PUBLIC, anon, authenticated, service_role;

DO $expectation$
DECLARE changed INTEGER;
BEGIN
    UPDATE private.koaryu_release_v31_expectations
    SET expected_sha256 = '168cc61b730cae592edaecdd15ca126ad891d6ed70bd5d523362693c662e2888'
    WHERE expectation_key = 'operational_contract_v31'
      AND expected_sha256 = '9f037cc4464637876016f47584d44910a6e175b2358eecb44486779273e75510';
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'V42 requires the exact V41 operational expectation singleton.'; END IF;
END;
$expectation$;

CREATE FUNCTION public.koaryu_release_schema_preflight_v23()
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
    IF v_count <> 137 OR v_head <> '20260910084231' THEN
        v_failures := array_append(v_failures, 'migration_history_v42');
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
        '20260826073728','20260826102840','20260826155911','20260826185651','20260830065627','20260830082610','20260830151714','20260831022021','20260831054918','20260902001000','20260905022339','20260908080420','20260908133504','20260908183744','20260910084231'
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
 RETURN QUERY SELECT cardinality(v_failures) = 0,
        v_count, v_head, COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures,
        'release-db-attestation-v42'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v23() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v23() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v23() TO service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v22()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT,
    pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $function$
DECLARE v RECORD;
BEGIN
    SELECT * INTO v FROM public.koaryu_release_schema_preflight_v23();
    IF v.ready IS TRUE AND v.migration_count = 137 AND v.migration_head = '20260910084231'
       AND v.manifest_version = 'release-db-attestation-v42'
       AND cardinality(v.security_failures) = 0 AND cardinality(v.pending_versions) = 53
       AND v.pending_versions[cardinality(v.pending_versions)] = '20260910084231' THEN
        RETURN QUERY SELECT TRUE, 136, '20260908183744'::TEXT,
            v.pending_versions[1:cardinality(v.pending_versions)-1],
            ARRAY[]::TEXT[], 'release-db-attestation-v41'::TEXT;
        RETURN;
    END IF;
    RETURN QUERY SELECT FALSE, v.migration_count, v.migration_head,
        v.pending_versions, v.security_failures, 'release-db-attestation-v41'::TEXT;
END;
$function$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v22() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v22() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v22() TO service_role;

DO $derived$
BEGIN
    IF private.koaryu_release_student_rank_writer_manifest_v11() IS DISTINCT FROM '0:055e856b82b43d1f62bc4e910bf58eae2de10272ebe22164d124e7f39598e54b' THEN
        RAISE EXCEPTION 'V42 student_rank_writer_manifest_v11 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13() IS DISTINCT FROM '0:3f1c13eabc799d9a80e7278cfe210510b573342a31065b834e4d6e68b6bf26ab' THEN
        RAISE EXCEPTION 'V42 student_rank_writer_manifest_v13 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_resource_ownership_manifest_v31() IS DISTINCT FROM '0:49fb66b782a732d495428e62c88ae227f32ef4c22be6d41a4cac0ff686f81e48' THEN
        RAISE EXCEPTION 'V42 resource_ownership_manifest_v31 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_operational_contract_v31() IS DISTINCT FROM '0:168cc61b730cae592edaecdd15ca126ad891d6ed70bd5d523362693c662e2888' THEN
        RAISE EXCEPTION 'V42 operational_contract_v31 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_operational_manifest_v12() IS DISTINCT FROM '9f3190acf304988b74da920b85a8e1cdb6a62eb8615017788b057b477667e5a2' THEN
        RAISE EXCEPTION 'V42 operational_manifest_v12 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v18() IS DISTINCT FROM '0:ffffe870f71abab5b1def36d5a496d2d5efa508204a773992c6d5fbe7aecae80' THEN
        RAISE EXCEPTION 'V42 critical_surface_manifest_v18 does not match the reviewed state.';
    END IF;
    IF private.koaryu_release_operational_manifest_v11() IS DISTINCT FROM '2efb0b2cf73beabfb219dd3642a824714c1b0619c5498ecf195071f929e651f6' THEN
        RAISE EXCEPTION 'V42 operational_manifest_v11 does not match the reviewed state.';
    END IF;
END;
$derived$;
