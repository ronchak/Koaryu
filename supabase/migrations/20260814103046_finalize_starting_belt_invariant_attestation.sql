-- Finish rank replacement after a DELETE statement has removed every omitted
-- rank. Row triggers cannot distinguish a survivor from another row that the
-- same statement will delete, so the final starting-belt repair belongs at the
-- statement boundary where the surviving ladder is authoritative.

-- Preserve deliberate unranked memberships during ordinary rank edits. This
-- trigger owns only the transition from no full belt to the first full belt;
-- the statement-level delete repair below owns replacement plans.
CREATE OR REPLACE FUNCTION public.backfill_starting_belt_for_program()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    target_program_id UUID;
BEGIN
    IF NEW.is_tip
       OR EXISTS (
           SELECT 1
           FROM public.belt_ranks rank
           WHERE rank.ladder_id = NEW.ladder_id
             AND rank.studio_id = NEW.studio_id
             AND rank.id <> NEW.id
             AND rank.is_tip = FALSE
       ) THEN
        RETURN NEW;
    END IF;

    SELECT ladder.program_id
    INTO target_program_id
    FROM public.belt_ladders ladder
    WHERE ladder.id = NEW.ladder_id
      AND ladder.studio_id = NEW.studio_id;

    IF target_program_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Match profile writes' students-then-memberships lock order.
    PERFORM 1
    FROM public.students student
    WHERE student.studio_id = NEW.studio_id
      AND EXISTS (
          SELECT 1
          FROM public.student_program_memberships membership
          WHERE membership.studio_id = NEW.studio_id
            AND membership.student_id = student.id
            AND membership.program_id = target_program_id
            AND membership.status IN ('active', 'paused')
            AND membership.ended_at IS NULL
            AND membership.current_belt_rank_id IS NULL
      )
    ORDER BY student.id
    FOR UPDATE;

    UPDATE public.student_program_memberships membership
    SET current_belt_rank_id = NEW.id,
        updated_at = NOW()
    WHERE membership.studio_id = NEW.studio_id
      AND membership.program_id = target_program_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
      AND membership.current_belt_rank_id IS NULL;

    RETURN NEW;
END;
$$;

CREATE FUNCTION public.backfill_starting_belt_after_rank_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- Statement triggers also fire for zero-row deletes. Return before touching
    -- protected tenant tables so a harmless cascade/delete cannot require
    -- unrelated student privileges.
    IF NOT EXISTS (SELECT 1 FROM deleted_belt_ranks) THEN
        RETURN NULL;
    END IF;

    -- Match profile writes' students-then-memberships lock order.
    PERFORM 1
    FROM public.students student
    WHERE EXISTS (
        SELECT 1
        FROM deleted_belt_ranks deleted_rank
        JOIN public.belt_ladders ladder
          ON ladder.id = deleted_rank.ladder_id
         AND ladder.studio_id = deleted_rank.studio_id
        JOIN public.student_program_memberships membership
          ON membership.studio_id = ladder.studio_id
         AND membership.student_id = student.id
         AND membership.program_id = ladder.program_id
        WHERE student.studio_id = ladder.studio_id
          AND student.program_id = ladder.program_id
          AND membership.status IN ('active', 'paused')
          AND membership.ended_at IS NULL
          AND membership.current_belt_rank_id IS NULL
          AND EXISTS (
              SELECT 1
              FROM public.belt_ranks surviving_rank
              WHERE surviving_rank.ladder_id = ladder.id
                AND surviving_rank.studio_id = ladder.studio_id
                AND surviving_rank.is_tip = FALSE
          )
    )
    ORDER BY student.id
    FOR UPDATE;

    WITH affected_programs AS (
        SELECT DISTINCT
            ladder.studio_id,
            ladder.program_id,
            ladder.id AS ladder_id
        FROM deleted_belt_ranks deleted_rank
        JOIN public.belt_ladders ladder
          ON ladder.id = deleted_rank.ladder_id
         AND ladder.studio_id = deleted_rank.studio_id
        WHERE ladder.program_id IS NOT NULL
    ),
    starting_ranks AS (
        SELECT DISTINCT ON (affected.studio_id, affected.program_id)
            affected.studio_id,
            affected.program_id,
            rank.id AS rank_id
        FROM affected_programs affected
        JOIN public.belt_ranks rank
          ON rank.ladder_id = affected.ladder_id
         AND rank.studio_id = affected.studio_id
         AND rank.is_tip = FALSE
        ORDER BY
            affected.studio_id,
            affected.program_id,
            rank.display_order,
            rank.created_at,
            rank.id
    )
    UPDATE public.student_program_memberships membership
    SET current_belt_rank_id = starting.rank_id,
        updated_at = NOW()
    FROM starting_ranks starting
    WHERE membership.studio_id = starting.studio_id
      AND membership.program_id = starting.program_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
      AND membership.current_belt_rank_id IS NULL;

    WITH affected_programs AS (
        SELECT DISTINCT ladder.studio_id, ladder.program_id
        FROM deleted_belt_ranks deleted_rank
        JOIN public.belt_ladders ladder
          ON ladder.id = deleted_rank.ladder_id
         AND ladder.studio_id = deleted_rank.studio_id
        WHERE ladder.program_id IS NOT NULL
    )
    UPDATE public.students student
    SET current_belt_rank_id = membership.current_belt_rank_id,
        updated_at = NOW()
    FROM public.student_program_memberships membership
    JOIN affected_programs affected
      ON affected.studio_id = membership.studio_id
     AND affected.program_id = membership.program_id
    WHERE student.id = membership.student_id
      AND student.studio_id = membership.studio_id
      AND student.program_id = membership.program_id
      AND membership.status IN ('active', 'paused')
      AND membership.ended_at IS NULL
      AND membership.current_belt_rank_id IS NOT NULL
      AND student.current_belt_rank_id IS DISTINCT FROM membership.current_belt_rank_id;

    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS backfill_starting_belt_after_rank_delete_trigger
    ON public.belt_ranks;
CREATE TRIGGER backfill_starting_belt_after_rank_delete_trigger
    AFTER DELETE ON public.belt_ranks
    REFERENCING OLD TABLE AS deleted_belt_ranks
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.backfill_starting_belt_after_rank_delete();

REVOKE ALL ON FUNCTION public.backfill_starting_belt_after_rank_delete()
    FROM PUBLIC, anon, authenticated, service_role;

-- Database-observable proof for the membership default, rank-reassignment,
-- sync, and trigger surface introduced by migrations 101-102. The operator
-- raw-catalog packet separately attests this helper's own body.
CREATE FUNCTION private.koaryu_release_starting_belt_manifest_v9()
RETURNS TEXT
LANGUAGE sql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$
WITH required_functions(signature, expected_config, service_execute) AS (
    VALUES
        ('public.validate_student_program_membership()', 'search_path=pg_catalog, public', FALSE),
        ('public.sync_primary_student_rank_from_membership()', 'search_path=pg_catalog, public', FALSE),
        ('public.backfill_starting_belt_for_program()', 'search_path=pg_catalog, public', FALSE),
        ('public.reassign_memberships_before_belt_rank_delete()', 'search_path=pg_catalog, public', FALSE),
        ('public.backfill_starting_belt_after_rank_delete()', 'search_path=pg_catalog, public', FALSE),
        ('public.sync_belt_ladder_ranks(uuid, uuid, text, jsonb)', 'search_path=public', TRUE)
),
function_actual AS (
    SELECT
        format('%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)) AS signature,
        owner.rolname AS owner_name,
        language.lanname AS language_name,
        function.prosecdef AS security_definer,
        COALESCE(array_to_string(function.proconfig, ','), '') AS config,
        EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            WHERE acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
        ) AS public_execute,
        has_function_privilege('anon', function.oid, 'EXECUTE') AS anon_execute,
        has_function_privilege('authenticated', function.oid, 'EXECUTE') AS authenticated_execute,
        has_function_privilege('service_role', function.oid, 'EXECUTE') AS service_execute,
        encode(extensions.digest(convert_to(function.prosrc, 'UTF8'), 'sha256'), 'hex') AS body_sha256,
        COALESCE((
            SELECT string_agg(
                COALESCE(grantor.rolname, 'PUBLIC') || '>' ||
                COALESCE(grantee.rolname, 'PUBLIC') || ':' ||
                acl.privilege_type || ':' || acl.is_grantable::TEXT,
                ',' ORDER BY
                    COALESCE(grantor.rolname, 'PUBLIC') COLLATE "C",
                    COALESCE(grantee.rolname, 'PUBLIC') COLLATE "C",
                    acl.privilege_type COLLATE "C",
                    acl.is_grantable
            )
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            LEFT JOIN pg_roles grantor ON grantor.oid = acl.grantor
            LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
        ), '') AS acl_state,
        EXISTS (
            SELECT 1
            FROM aclexplode(COALESCE(function.proacl, acldefault('f', function.proowner))) acl
            LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
            WHERE acl.privilege_type = 'EXECUTE'
              AND acl.grantee <> function.proowner
              AND NOT (
                  grantee.rolname = 'service_role'
                  AND required.service_execute
                  AND NOT acl.is_grantable
              )
        ) AS unexpected_execute_grant
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_roles owner ON owner.oid = function.proowner
    JOIN pg_language language ON language.oid = function.prolang
    JOIN required_functions required
      ON required.signature = format(
          '%I.%I(%s)', namespace.nspname, function.proname, oidvectortypes(function.proargtypes)
      )
),
function_compared AS (
    SELECT
        required.*,
        actual.owner_name,
        actual.language_name,
        actual.security_definer,
        actual.config,
        actual.public_execute,
        actual.anon_execute,
        actual.authenticated_execute,
        actual.service_execute AS actual_service_execute,
        actual.body_sha256,
        actual.acl_state,
        actual.unexpected_execute_grant
    FROM required_functions required
    LEFT JOIN function_actual actual USING (signature)
),
required_triggers(table_name, trigger_name, function_name, trigger_type) AS (
    VALUES
        ('student_program_memberships', 'validate_student_program_membership_trigger', 'validate_student_program_membership', 23),
        ('student_program_memberships', 'sync_primary_student_rank_from_membership_trigger', 'sync_primary_student_rank_from_membership', 21),
        ('belt_ranks', 'backfill_starting_belt_for_program_trigger', 'backfill_starting_belt_for_program', 21),
        ('belt_ranks', 'reassign_memberships_before_belt_rank_delete_trigger', 'reassign_memberships_before_belt_rank_delete', 11),
        ('belt_ranks', 'backfill_starting_belt_after_rank_delete_trigger', 'backfill_starting_belt_after_rank_delete', 8)
),
trigger_actual AS (
    SELECT
        relation.relname AS table_name,
        trigger.tgname AS trigger_name,
        function.proname AS function_name,
        trigger.tgtype::INTEGER AS trigger_type,
        trigger.tgenabled,
        trigger.tgisinternal,
        encode(
            extensions.digest(convert_to(pg_get_triggerdef(trigger.oid), 'UTF8'), 'sha256'),
            'hex'
        ) AS definition_sha256
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc function ON function.oid = trigger.tgfoid
    JOIN pg_namespace function_namespace ON function_namespace.oid = function.pronamespace
    JOIN required_triggers required
      ON required.table_name = relation.relname
     AND required.trigger_name = trigger.tgname
    WHERE namespace.nspname = 'public'
      AND function_namespace.nspname = 'public'
),
trigger_compared AS (
    SELECT
        required.*,
        actual.function_name AS actual_function_name,
        actual.trigger_type AS actual_trigger_type,
        actual.tgenabled,
        actual.tgisinternal,
        actual.definition_sha256
    FROM required_triggers required
    LEFT JOIN trigger_actual actual USING (table_name, trigger_name)
),
invalid AS (
    SELECT
        (SELECT count(*)
         FROM function_compared function
         WHERE function.owner_name IS DISTINCT FROM 'postgres'
            OR function.language_name IS DISTINCT FROM 'plpgsql'
            OR function.security_definer IS DISTINCT FROM FALSE
            OR function.config IS DISTINCT FROM function.expected_config
            OR function.public_execute IS DISTINCT FROM FALSE
            OR function.anon_execute IS DISTINCT FROM FALSE
            OR function.authenticated_execute IS DISTINCT FROM FALSE
            OR function.actual_service_execute IS DISTINCT FROM function.service_execute
            OR function.unexpected_execute_grant IS DISTINCT FROM FALSE
            OR function.body_sha256 IS NULL)
        +
        (SELECT count(*)
         FROM trigger_compared trigger
         WHERE trigger.actual_function_name IS DISTINCT FROM trigger.function_name
            OR trigger.actual_trigger_type IS DISTINCT FROM trigger.trigger_type
            OR trigger.tgenabled IS DISTINCT FROM 'O'
            OR trigger.tgisinternal IS DISTINCT FROM FALSE
            OR trigger.definition_sha256 IS NULL) AS invalid_count
),
state AS (
    SELECT
        'function'::TEXT AS kind,
        function.signature AS identity,
        concat_ws('|',
            function.owner_name,
            function.language_name,
            function.security_definer::TEXT,
            function.config,
            function.public_execute::TEXT,
            function.anon_execute::TEXT,
            function.authenticated_execute::TEXT,
            function.actual_service_execute::TEXT,
            function.body_sha256,
            function.acl_state,
            function.unexpected_execute_grant::TEXT
        ) AS payload
    FROM function_compared function
    UNION ALL
    SELECT
        'trigger',
        trigger.table_name || '.' || trigger.trigger_name,
        concat_ws('|',
            trigger.actual_function_name,
            trigger.actual_trigger_type::TEXT,
            trigger.tgenabled::TEXT,
            trigger.tgisinternal::TEXT,
            trigger.definition_sha256
        )
    FROM trigger_compared trigger
)
SELECT invalid.invalid_count::TEXT || ':' || encode(
    extensions.digest(
        convert_to(
            COALESCE(string_agg(
                state.kind || ':' || state.identity || ':' || state.payload,
                '|' ORDER BY state.kind COLLATE "C", state.identity COLLATE "C"
            ), ''),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
FROM state
CROSS JOIN invalid
GROUP BY invalid.invalid_count;
$$;

ALTER FUNCTION private.koaryu_release_starting_belt_manifest_v9()
    OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_starting_belt_manifest_v9()
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

    IF v_count <> 102
       OR v_head <> '20260814103046'
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
           '20260814103046'
       ]::TEXT[]
       OR v_baseline <> '84:57ae4269ef4d75c249d59ef297661a3a' THEN
        v_failures := array_append(v_failures, 'migration_history_v9');
    END IF;

    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;

    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:367516cc9b324bca35445f07c1f4d7e58e897e189edaa334c520e55aed9618a2' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;

    RETURN QUERY SELECT
        cardinality(v_failures) = 0,
        v_count,
        v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]),
        v_failures,
        'release-db-attestation-v9';
END;
$preflight$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2()
    TO service_role;

COMMENT ON FUNCTION public.koaryu_release_schema_preflight_v2() IS
    'Operational exact-head V9 drift signal. V9 attests the starting-belt invariant and advances migration history while retaining the V7 billing and release-control manifest.';
