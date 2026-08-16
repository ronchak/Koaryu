-- Migration 111: retained staff-role archive state and database-wide access
-- revocation. Archived rows remain identity reservations, but never grant
-- tenant access. The readiness definitions below are replaced only after the
-- archive/RLS/guard surface has been installed.

ALTER TABLE public.staff_roles
    ADD COLUMN archived_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION private.has_unambiguous_studio_membership()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        auth.uid() IS NOT NULL
        AND NOT EXISTS (
            SELECT 1
            FROM public.staff_roles AS archived_membership
            WHERE archived_membership.user_id = auth.uid()
              AND archived_membership.archived_at IS NOT NULL
        )
        AND (
            SELECT COUNT(DISTINCT membership.studio_id) <= 1
            FROM public.staff_roles AS membership
            WHERE membership.user_id = auth.uid()
        );
$$;

ALTER FUNCTION private.has_unambiguous_studio_membership() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.has_unambiguous_studio_membership()
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.has_unambiguous_studio_membership()
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_staff_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        private.has_unambiguous_studio_membership()
        AND EXISTS (
            SELECT 1
            FROM public.staff_roles AS membership
            WHERE membership.studio_id = target_studio_id
              AND membership.user_id = auth.uid()
              AND membership.archived_at IS NULL
        );
$$;

ALTER FUNCTION private.is_staff_in_studio(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.is_staff_in_studio(UUID)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_staff_in_studio(UUID)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_admin_or_front_desk_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        private.has_unambiguous_studio_membership()
        AND EXISTS (
            SELECT 1
            FROM public.staff_roles AS membership
            WHERE membership.studio_id = target_studio_id
              AND membership.user_id = auth.uid()
              AND membership.archived_at IS NULL
              AND membership.role IN ('admin', 'front_desk')
        );
$$;

ALTER FUNCTION private.is_admin_or_front_desk_in_studio(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.is_admin_or_front_desk_in_studio(UUID)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_admin_or_front_desk_in_studio(UUID)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_admin_in_studio(target_studio_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        private.has_unambiguous_studio_membership()
        AND EXISTS (
            SELECT 1
            FROM public.staff_roles AS membership
            WHERE membership.studio_id = target_studio_id
              AND membership.user_id = auth.uid()
              AND membership.archived_at IS NULL
              AND membership.role = 'admin'
        );
$$;

ALTER FUNCTION private.is_admin_in_studio(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.is_admin_in_studio(UUID)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.is_admin_in_studio(UUID)
TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.can_read_staff_profile(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT
        auth.uid() IS NOT NULL
        AND private.has_unambiguous_studio_membership()
        AND EXISTS (
            SELECT 1
            FROM public.staff_roles AS caller_membership
            JOIN public.staff_roles AS target_membership
              ON target_membership.studio_id = caller_membership.studio_id
            WHERE caller_membership.user_id = auth.uid()
              AND caller_membership.archived_at IS NULL
              AND target_membership.user_id = target_user_id
              AND target_membership.archived_at IS NULL
        );
$$;

ALTER FUNCTION private.can_read_staff_profile(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION private.can_read_staff_profile(UUID)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.can_read_staff_profile(UUID)
TO authenticated;

-- Re-apply the central guard after the new archive-aware owner exists. This
-- covers every current public RLS table, including staff_profiles, and keeps a
-- later public RLS table from gaining an alternate tenant-access path.
DO $$
DECLARE
    target_table RECORD;
BEGIN
    FOR target_table IN
        SELECT namespace.nspname AS schema_name, relation.relname AS table_name
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND relation.relrowsecurity
    LOOP
        EXECUTE pg_catalog.format(
            'DROP POLICY IF EXISTS %I ON %I.%I',
            'reject_ambiguous_staff_membership_select',
            target_table.schema_name,
            target_table.table_name
        );

        EXECUTE pg_catalog.format(
            'DROP POLICY IF EXISTS %I ON %I.%I',
            'reject_ambiguous_staff_membership_access',
            target_table.schema_name,
            target_table.table_name
        );

        EXECUTE pg_catalog.format(
            'CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT private.has_unambiguous_studio_membership())) WITH CHECK ((SELECT private.has_unambiguous_studio_membership()))',
            'reject_ambiguous_staff_membership_access',
            target_table.schema_name,
            target_table.table_name
        );
    END LOOP;
END
$$;

-- Browser roles never write staff_roles. The service-role backend remains the
-- sole archive/unarchive writer, while the existing SELECT policy remains the
-- caller-self boundary for active identities.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.staff_roles
FROM PUBLIC, anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.staff_roles TO service_role;

CREATE OR REPLACE FUNCTION private.prevent_account_deletion_orphan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_studio UUID;
    survivor_count INTEGER;
BEGIN
    IF NEW.status <> 'scheduled' OR NEW.user_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.studios AS studio
        WHERE studio.owner_id = NEW.user_id
    ) THEN
        RAISE EXCEPTION 'Transfer studio ownership before deleting this account.'
            USING ERRCODE = '23514';
    END IF;

    FOR affected_studio IN
        SELECT DISTINCT membership.studio_id
        FROM public.staff_roles AS membership
        WHERE membership.user_id = NEW.user_id
          AND membership.role = 'admin'
          AND membership.archived_at IS NULL
    LOOP
        PERFORM 1
        FROM public.studios AS studio
        WHERE studio.id = affected_studio
        FOR UPDATE;

        SELECT COUNT(*) INTO survivor_count
        FROM public.staff_roles AS membership
        JOIN auth.users AS auth_user
          ON auth_user.id = membership.user_id
        WHERE membership.studio_id = affected_studio
          AND membership.role = 'admin'
          AND membership.archived_at IS NULL
          AND membership.user_id <> NEW.user_id
          AND (auth_user.email_confirmed_at IS NOT NULL OR auth_user.last_sign_in_at IS NOT NULL)
          AND NOT EXISTS (
              SELECT 1
              FROM public.account_deletion_requests AS deletion_request
              WHERE deletion_request.user_id = membership.user_id
                AND deletion_request.status = 'scheduled'
                AND deletion_request.id <> NEW.id
          );

        IF survivor_count < 1 THEN
            RAISE EXCEPTION 'Add another active admin before deleting this account.'
                USING ERRCODE = '23514';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

ALTER FUNCTION private.prevent_account_deletion_orphan() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.prevent_account_deletion_orphan()
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.prevent_staff_admin_orphan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_studio UUID;
    departing_user UUID;
    survivor_count INTEGER;
    active_admin_departing BOOLEAN := false;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.user_id IS NOT NULL
           AND (
               NEW.user_id IS DISTINCT FROM OLD.user_id
               OR (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
               OR (OLD.role = 'admin' AND NEW.role IS DISTINCT FROM 'admin')
           ) THEN
            affected_studio := OLD.studio_id;
            departing_user := OLD.user_id;
            active_admin_departing := OLD.role = 'admin' AND OLD.archived_at IS NULL;
        ELSE
            RETURN NEW;
        END IF;
    ELSIF TG_OP = 'DELETE' THEN
        affected_studio := OLD.studio_id;
        departing_user := OLD.user_id;
        active_admin_departing := OLD.role = 'admin'
            AND OLD.archived_at IS NULL
            AND OLD.user_id IS NOT NULL;
    ELSE
        RETURN NEW;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.studios AS studio
        WHERE studio.id = affected_studio
          AND studio.owner_id = departing_user
    ) THEN
        IF TG_OP = 'UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
            RAISE EXCEPTION 'Transfer studio ownership before replacing or clearing this staff member identity.'
                USING ERRCODE = '23514';
        ELSIF TG_OP = 'UPDATE' AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'Transfer studio ownership before archiving this staff member.'
                USING ERRCODE = '23514';
        END IF;

        RAISE EXCEPTION 'Transfer studio ownership before deleting or demoting this staff member.'
            USING ERRCODE = '23514';
    END IF;

    IF NOT active_admin_departing THEN
        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        END IF;
        RETURN NEW;
    END IF;

    PERFORM 1
    FROM public.studios AS studio
    WHERE studio.id = affected_studio
    FOR UPDATE;

    SELECT COUNT(*) INTO survivor_count
    FROM public.staff_roles AS membership
    JOIN auth.users AS auth_user
      ON auth_user.id = membership.user_id
    WHERE membership.studio_id = affected_studio
      AND membership.role = 'admin'
      AND membership.archived_at IS NULL
      AND membership.user_id <> departing_user
      AND (auth_user.email_confirmed_at IS NOT NULL OR auth_user.last_sign_in_at IS NOT NULL)
      AND NOT EXISTS (
          SELECT 1
          FROM public.account_deletion_requests AS deletion_request
          WHERE deletion_request.user_id = membership.user_id
            AND deletion_request.status = 'scheduled'
      );

    IF survivor_count < 1 THEN
        RAISE EXCEPTION 'At least one active admin not scheduled for deletion must remain in the studio.'
            USING ERRCODE = '23514';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION private.prevent_staff_admin_orphan() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.prevent_staff_admin_orphan()
FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS prevent_staff_admin_orphan_update_trigger ON public.staff_roles;
CREATE TRIGGER prevent_staff_admin_orphan_update_trigger
    BEFORE UPDATE OF role, user_id, archived_at ON public.staff_roles
    FOR EACH ROW
    EXECUTE FUNCTION private.prevent_staff_admin_orphan();

-- Preserve the any-row single-studio reservation: archived and pending rows
-- still block a second studio membership through the existing trigger.

CREATE FUNCTION private.koaryu_release_critical_surface_manifest_v17()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_v16 TEXT;
    v_invalid INTEGER;
    v_serialized TEXT;
BEGIN
    v_v16 := private.koaryu_release_critical_surface_manifest_v16();
    v_invalid := COALESCE(NULLIF(split_part(v_v16, ':', 1), '')::INTEGER, 1);

    WITH required_functions(
        signature,
        expected_search_path,
        expected_volatility,
        expected_security_definer,
        expected_authenticated_execute,
        expected_service_execute
    ) AS (
        VALUES
          ('private.has_unambiguous_studio_membership()', 'search_path=""', 's', true, true, true),
          ('private.is_staff_in_studio(uuid)', 'search_path=""', 's', true, true, true),
          ('private.is_admin_or_front_desk_in_studio(uuid)', 'search_path=""', 's', true, true, true),
          ('private.is_admin_in_studio(uuid)', 'search_path=""', 's', true, true, true),
          ('private.can_read_staff_profile(uuid)', 'search_path=""', 's', true, true, false),
          ('private.prevent_account_deletion_orphan()', 'search_path=""', 'v', true, false, false),
          ('private.prevent_staff_admin_orphan()', 'search_path=""', 'v', true, false, false),
          ('private.koaryu_release_critical_surface_manifest_v17()', 'search_path=pg_catalog', 's', false, false, false)
    ), function_state AS (
        SELECT
            required.signature,
            required.expected_search_path,
            required.expected_volatility,
            required.expected_security_definer,
            required.expected_authenticated_execute,
            required.expected_service_execute,
            procedure.oid,
            COALESCE(pg_get_functiondef(procedure.oid), '') AS definition,
            COALESCE(owner.rolname, '') AS owner_name,
            COALESCE(procedure.provolatile::TEXT, '') AS volatility,
            COALESCE(procedure.prosecdef::TEXT, '') AS security_definer,
            COALESCE(array_to_string(procedure.proconfig, ','), '') AS configuration,
            COALESCE(array_to_string(procedure.proacl, ','), '') AS acl,
            has_function_privilege('authenticated', procedure.oid, 'EXECUTE') AS authenticated_execute,
            has_function_privilege('service_role', procedure.oid, 'EXECUTE') AS service_execute,
            EXISTS (
                SELECT 1
                FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) AS privilege
                LEFT JOIN pg_roles AS grantee
                  ON grantee.oid = privilege.grantee
                WHERE privilege.privilege_type = 'EXECUTE'
                  AND privilege.grantee <> procedure.proowner
                  AND NOT (
                      grantee.rolname = 'authenticated'
                      AND required.expected_authenticated_execute
                      AND NOT privilege.is_grantable
                  )
                  AND NOT (
                      grantee.rolname = 'service_role'
                      AND required.expected_service_execute
                      AND NOT privilege.is_grantable
                  )
            ) AS unexpected_execute_grant
        FROM required_functions AS required
        LEFT JOIN pg_proc AS procedure
          ON procedure.oid = to_regprocedure(required.signature)
        LEFT JOIN pg_roles AS owner
          ON owner.oid = procedure.proowner
    ), required_columns(table_name, column_name, expected_type, expected_nullable) AS (
        VALUES ('staff_roles', 'archived_at', 'timestamp with time zone', 'YES')
    ), column_state AS (
        SELECT
            required.table_name,
            required.column_name,
            required.expected_type,
            required.expected_nullable,
            actual.data_type,
            actual.is_nullable,
            actual.ordinal_position
        FROM required_columns AS required
        LEFT JOIN information_schema.columns AS actual
          ON actual.table_schema = 'public'
         AND actual.table_name = required.table_name
         AND actual.column_name = required.column_name
    ), required_triggers(
        table_name,
        trigger_name,
        function_schema,
        function_name,
        expected_trigger_type
    ) AS (
        VALUES
          ('staff_roles', 'prevent_staff_admin_orphan_update_trigger', 'private', 'prevent_staff_admin_orphan', '19'),
          ('staff_roles', 'prevent_staff_admin_orphan_delete_trigger', 'private', 'prevent_staff_admin_orphan', '11'),
          ('account_deletion_requests', 'prevent_account_deletion_orphan_trigger', 'private', 'prevent_account_deletion_orphan', '23')
    ), trigger_state AS (
        SELECT
            required.table_name,
            required.trigger_name,
            required.function_schema,
            required.function_name,
            required.expected_trigger_type,
            trigger_row.oid,
            COALESCE(pg_get_triggerdef(trigger_row.oid), '') AS definition,
            COALESCE(trigger_row.tgenabled::TEXT, '') AS enabled,
            COALESCE(trigger_row.tgtype::TEXT, '') AS trigger_type,
            COALESCE(function_schema.nspname, '') AS actual_function_schema,
            COALESCE(function_row.proname, '') AS actual_function_name
        FROM required_triggers AS required
        LEFT JOIN pg_class AS relation
          ON relation.relname = required.table_name
         AND relation.relnamespace = 'public'::REGNAMESPACE
        LEFT JOIN pg_trigger AS trigger_row
          ON trigger_row.tgrelid = relation.oid
         AND trigger_row.tgname = required.trigger_name
         AND NOT trigger_row.tgisinternal
        LEFT JOIN pg_proc AS function_row
          ON function_row.oid = trigger_row.tgfoid
        LEFT JOIN pg_namespace AS function_schema
          ON function_schema.oid = function_row.pronamespace
    ), guarded_tables AS (
        SELECT
            relation.relname AS table_name,
            EXISTS (
                SELECT 1
                FROM pg_policy AS policy
                WHERE policy.polrelid = relation.oid
                  AND NOT policy.polpermissive
                  AND policy.polcmd = '*'
                  AND policy.polroles = ARRAY[
                      (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
                  ]::OID[]
                  AND regexp_replace(
                      pg_get_expr(policy.polqual, policy.polrelid),
                      '[[:space:]]+', '', 'g'
                  ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
                  AND regexp_replace(
                      pg_get_expr(policy.polwithcheck, policy.polrelid),
                      '[[:space:]]+', '', 'g'
                  ) = '(SELECTprivate.has_unambiguous_studio_membership()AShas_unambiguous_studio_membership)'
            ) AS guarded
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND relation.relrowsecurity
    ), serialized AS (
        SELECT
            'f:' || signature || ':' || definition || ':' || owner_name || ':' ||
            volatility || ':' || security_definer || ':' || configuration || ':' || acl || ':' ||
            authenticated_execute::TEXT || ':' || service_execute::TEXT AS value,
            (
                oid IS NULL
                OR owner_name <> 'postgres'
                OR volatility <> expected_volatility
                OR security_definer <> expected_security_definer::TEXT
                OR configuration <> expected_search_path
                OR authenticated_execute IS DISTINCT FROM expected_authenticated_execute
                OR service_execute IS DISTINCT FROM expected_service_execute
                OR unexpected_execute_grant
            )::INTEGER AS invalid
        FROM function_state
        UNION ALL
        SELECT
            'c:' || table_name || ':' || column_name || ':' ||
            COALESCE(data_type, '') || ':' || COALESCE(is_nullable, ''),
            (
                data_type IS DISTINCT FROM expected_type
                OR is_nullable IS DISTINCT FROM expected_nullable
            )::INTEGER
        FROM column_state
        UNION ALL
        SELECT
            't:' || table_name || ':' || trigger_name || ':' || definition || ':' ||
            enabled || ':' || trigger_type || ':' || actual_function_schema || '.' || actual_function_name,
            (
                oid IS NULL
                OR enabled <> 'O'
                OR trigger_type <> expected_trigger_type
                OR actual_function_schema <> function_schema
                OR actual_function_name <> function_name
            )::INTEGER
        FROM trigger_state
        UNION ALL
        SELECT
            'g:public.' || table_name || ':' || guarded::TEXT,
            (NOT guarded)::INTEGER
        FROM guarded_tables
    )
    SELECT
        v_invalid + COALESCE(sum(invalid), 0)::INTEGER,
        'v16:' || COALESCE(v_v16, '') || '|' ||
        string_agg(value, '|' ORDER BY value COLLATE "C")
    INTO v_invalid, v_serialized
    FROM serialized;

    RETURN v_invalid::TEXT || ':' || encode(
        extensions.digest(convert_to(v_serialized, 'UTF8'), 'sha256'),
        'hex'
    );
END;
$$;

ALTER FUNCTION private.koaryu_release_critical_surface_manifest_v17() OWNER TO postgres;
REVOKE ALL ON FUNCTION private.koaryu_release_critical_surface_manifest_v17()
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v3()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT, pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_count INTEGER;
    v_head TEXT;
    v_pending TEXT[];
    v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
    SELECT count(*)::INTEGER, max(version),
           array_agg(version ORDER BY version COLLATE "C") FILTER (WHERE version >= '20260727100000')
    INTO v_count, v_head, v_pending
    FROM supabase_migrations.schema_migrations;

    IF v_count <> 111 OR v_head <> '20260816012723' THEN
        v_failures := array_append(v_failures, 'migration_history_v18');
    END IF;
    IF COALESCE(v_pending, ARRAY[]::TEXT[]) IS DISTINCT FROM ARRAY[
        '20260727100000','20260727110000','20260801050957','20260801060000',
        '20260801070000','20260801080000','20260801090000','20260801091000',
        '20260801092000','20260801093000','20260801094000','20260801105313',
        '20260801112153','20260801115044','20260801123112','20260801131844',
        '20260814043325','20260814103046','20260814105424','20260814114500',
        '20260814152000','20260814170000','20260814183000','20260814200000',
        '20260814213000','20260815220402','20260816012723'
    ]::TEXT[] THEN
        v_failures := array_append(v_failures, 'migration_history_sequence_v18');
    END IF;
    IF private.koaryu_release_operational_manifest_v7()
       <> 'd621d0bfa18b21571132a51108dd418e66996944fb7723bd3aeb624da7fe0e79' THEN
        v_failures := array_append(v_failures, 'operational_semantic_acl_manifest_v7');
    END IF;
    IF private.koaryu_release_starting_belt_manifest_v9()
       <> '0:9c1c8ea5e7ab6ce0d34d5654d17b056faba89234f0f2b945ff147c0462711be9' THEN
        v_failures := array_append(v_failures, 'starting_belt_invariant_manifest_v9');
    END IF;
    IF private.koaryu_release_student_rank_writer_manifest_v13()
       <> '0:27cdc692d92fb49f696521e7ab6f3d0b7717c30a232ba6ce4ba057df9e5b30f7' THEN
        v_failures := array_append(v_failures, 'student_rank_writer_manifest_v13');
    END IF;
    IF private.koaryu_release_critical_surface_manifest_v17()
       <> '0:05a77426d6e3e1864fe4d1a6beea708cc501b228e670a0309d1420808d2feab8' THEN
        v_failures := array_append(v_failures, 'critical_surface_manifest_v17');
    END IF;

    RETURN QUERY SELECT cardinality(v_failures) = 0, v_count, v_head,
        COALESCE(v_pending, ARRAY[]::TEXT[]), v_failures, 'release-db-attestation-v18';
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v3() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v3()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v3() TO service_role;

-- Preserve the deployed origin/main application's exact V7-shaped response,
-- but only when the new V3 contract proves the complete V18 state.
CREATE OR REPLACE FUNCTION public.koaryu_release_schema_preflight_v2()
RETURNS TABLE (ready BOOLEAN, migration_count INTEGER, migration_head TEXT, pending_versions TEXT[], security_failures TEXT[], manifest_version TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_current RECORD;
BEGIN
    SELECT * INTO v_current
    FROM public.koaryu_release_schema_preflight_v3();

    IF v_current.ready IS TRUE
       AND v_current.migration_count = 111
       AND v_current.migration_head = '20260816012723'
       AND v_current.manifest_version = 'release-db-attestation-v18'
       AND cardinality(v_current.security_failures) = 0 THEN
        RETURN QUERY SELECT
            TRUE,
            100,
            '20260801131844'::TEXT,
            ARRAY[
                '20260727100000','20260727110000','20260801050957','20260801060000',
                '20260801070000','20260801080000','20260801090000','20260801091000',
                '20260801092000','20260801093000','20260801094000','20260801105313',
                '20260801112153','20260801115044','20260801123112','20260801131844'
            ]::TEXT[],
            ARRAY[]::TEXT[],
            'release-db-attestation-v7'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT
        FALSE,
        v_current.migration_count,
        v_current.migration_head,
        v_current.pending_versions,
        COALESCE(v_current.security_failures, ARRAY['v18_compatibility_preflight']::TEXT[]),
        'release-db-attestation-v7'::TEXT;
END;
$$;

ALTER FUNCTION public.koaryu_release_schema_preflight_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.koaryu_release_schema_preflight_v2()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.koaryu_release_schema_preflight_v2() TO service_role;
