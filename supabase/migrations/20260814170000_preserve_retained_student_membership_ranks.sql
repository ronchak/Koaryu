-- Preserve each retained program membership's belt rank when the atomic profile
-- writer changes the primary program, then attest the resulting writer body.

CREATE OR REPLACE FUNCTION public.write_student_profile_atomic(
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
SET search_path = pg_catalog, public, private
AS $$
DECLARE
    v_student JSONB := p_student;
    v_existing_program_id UUID;
    v_rank_was_supplied BOOLEAN := p_student IS NOT NULL
        AND jsonb_typeof(p_student) = 'object'
        AND p_student ? 'current_belt_rank_id';
    v_retained_membership_ranks JSONB := '{}'::JSONB;
    v_result public.students%ROWTYPE;
BEGIN
    IF p_replace_programs AND cardinality(p_program_ids) > 0 THEN
        SELECT COALESCE(
            jsonb_object_agg(
                locked.program_id::TEXT,
                COALESCE(to_jsonb(locked.current_belt_rank_id), 'null'::JSONB)
            ),
            '{}'::JSONB
        )
        INTO v_retained_membership_ranks
        FROM (
            SELECT membership.program_id, membership.current_belt_rank_id
            FROM public.student_program_memberships membership
            WHERE membership.student_id = p_student_id
              AND membership.studio_id = p_studio_id
              AND membership.program_id = ANY(p_program_ids)
              AND membership.status IN ('active', 'paused')
              AND membership.ended_at IS NULL
            FOR UPDATE
        ) locked;
    END IF;

    IF p_replace_programs
       AND cardinality(p_program_ids) > 0
       AND p_student IS NOT NULL
       AND jsonb_typeof(p_student) = 'object'
       AND NOT (p_student ? 'current_belt_rank_id') THEN
        SELECT student.program_id
        INTO v_existing_program_id
        FROM public.students student
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id;

        IF FOUND AND v_existing_program_id IS DISTINCT FROM p_program_ids[1] THEN
            v_student := jsonb_set(
                v_student,
                '{current_belt_rank_id}',
                'null'::JSONB,
                TRUE
            );
        END IF;
    END IF;

    SELECT *
    INTO v_result
    FROM private.write_student_profile_atomic(
        p_student_id,
        p_studio_id,
        p_actor_id,
        v_student,
        p_program_ids,
        p_guardians,
        p_replace_programs,
        p_audit_action
    );

    IF p_replace_programs AND cardinality(p_program_ids) > 0 THEN
        UPDATE public.student_program_memberships membership
        SET current_belt_rank_id = (saved.value #>> '{}')::UUID,
            updated_at = NOW()
        FROM jsonb_each(v_retained_membership_ranks) saved
        WHERE membership.student_id = p_student_id
          AND membership.studio_id = p_studio_id
          AND membership.program_id = saved.key::UUID
          AND membership.program_id = ANY(p_program_ids)
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL
          AND membership.current_belt_rank_id IS NULL
          AND saved.value <> 'null'::JSONB
          AND (
              membership.program_id IS DISTINCT FROM p_program_ids[1]
              OR NOT v_rank_was_supplied
          )
          AND EXISTS (
              SELECT 1
              FROM public.belt_ranks rank
              JOIN public.belt_ladders ladder
                ON ladder.id = rank.ladder_id
               AND ladder.studio_id = rank.studio_id
              WHERE rank.id = (saved.value #>> '{}')::UUID
                AND rank.studio_id = p_studio_id
                AND ladder.program_id = membership.program_id
          );

        UPDATE public.students student
        SET current_belt_rank_id = membership.current_belt_rank_id,
            updated_at = NOW()
        FROM public.student_program_memberships membership
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id
          AND membership.student_id = student.id
          AND membership.studio_id = student.studio_id
          AND membership.program_id = student.program_id
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL
          AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

        SELECT *
        INTO v_result
        FROM public.students student
        WHERE student.id = p_student_id
          AND student.studio_id = p_studio_id;
    END IF;

    RETURN v_result;
END;
$$;

ALTER FUNCTION public.write_student_profile_atomic(
    UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.write_student_profile_atomic(
    UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_student_profile_atomic(
    UUID, UUID, UUID, JSONB, UUID[], JSONB, BOOLEAN, TEXT
) TO service_role;

CREATE FUNCTION private.koaryu_release_student_rank_writer_manifest_v13()
RETURNS TEXT
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$
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
              '0:ab551348b1c89f0bda600d3195e1f4556d4164035cd72272c29ae5d6b00674f3'
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
$$;

ALTER FUNCTION private.koaryu_release_student_rank_writer_manifest_v13()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_student_rank_writer_manifest_v13()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (
    ready BOOLEAN,
    migration_count INTEGER,
    migration_head TEXT,
    pending_versions TEXT[],
    security_failures TEXT[],
    manifest_version TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $preflight$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_baseline TEXT;
    v_prior RECORD;
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT * INTO v_prior
    FROM public.koaryu_release_schema_preflight_v6();

    v_failures := array_remove(
        array_remove(v_prior.security_failures, 'migration_history_v6'),
        'operational_semantic_acl_manifest_v6'
    );

    SELECT count(*)::INTEGER,
           max(version),
           array_agg(version ORDER BY version COLLATE "C")
             FILTER (WHERE version >= '20260727100000'),
           count(*) FILTER (WHERE version < '20260727100000')::TEXT || ':' ||
             md5(string_agg(version || ':' || name, '|' ORDER BY version COLLATE "C")
                 FILTER (WHERE version < '20260727100000'))
    INTO v_count, v_head, v_pending, v_baseline
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 106
       OR v_head <> '20260814170000'
       OR v_pending IS DISTINCT FROM ARRAY[
           '20260727100000',
           '20260727110000',
           '20260801050957',
           '20260801060000',
           '20260801070000',
           '20260801080000',
           '20260801090000',
           '20260801091000',
           '20260801092000',
           '20260801093000',
           '20260801094000',
           '20260801105313',
           '20260801112153',
           '20260801115044',
           '20260801123112',
           '20260801131844',
           '20260814043325',
           '20260814103046',
           '20260814105424',
           '20260814114500',
           '20260814152000',
           '20260814170000'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v13');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:872d8e3159278a82fc8d72f248d6b131ec8e87d679de19b0e889ab83eb39e653' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;

    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:dc6367b391430446f5c93638f1f46777828db9b54889d57ba72db9670ccd1e17' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v13';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V13 drift signal. V13 attests retained multi-program rank preservation, all four writer bodies and return contracts, the V9 starting-belt invariant, and migration history.';
