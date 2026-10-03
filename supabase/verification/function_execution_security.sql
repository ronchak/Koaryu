DO $$
DECLARE
    v_function RECORD;
    v_is_authenticated_helper BOOLEAN;
    v_original_role NAME := current_user;
    v_canary_schema NAME;
    v_canary_name CONSTANT NAME := 'authorization_test_canary';
    v_canary_oid OID;
    v_denied BOOLEAN;
    v_liveness INTEGER;
BEGIN
    IF has_schema_privilege('anon', 'public', 'CREATE')
       OR has_schema_privilege('authenticated', 'public', 'CREATE') THEN
        RAISE EXCEPTION 'Client roles must not create objects in the public schema';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_default_acl AS defaults
        WHERE defaults.defaclrole = (
            SELECT role.oid FROM pg_roles AS role WHERE role.rolname = current_user
        )
          AND defaults.defaclnamespace = 0
          AND defaults.defaclobjtype = 'f'
          AND NOT EXISTS (
              SELECT 1
              FROM aclexplode(defaults.defaclacl) AS privilege
              WHERE privilege.grantee = 0
                AND privilege.privilege_type = 'EXECUTE'
          )
    ) THEN
        RAISE EXCEPTION 'Migration owner must revoke the global PUBLIC function EXECUTE default';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_default_acl AS defaults
        JOIN pg_namespace AS namespace ON namespace.oid = defaults.defaclnamespace
        CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS privilege
        JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
        WHERE defaults.defaclrole = (
            SELECT role.oid FROM pg_roles AS role WHERE role.rolname = current_user
        )
          AND defaults.defaclobjtype = 'f'
          AND namespace.nspname IN ('public', 'private')
          AND grantee.rolname IN ('anon', 'authenticated', 'service_role')
          AND privilege.privilege_type = 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'Supabase API roles must not inherit schema-local function EXECUTE defaults';
    END IF;

    FOR v_function IN
        SELECT
            p.oid,
            n.nspname AS schema_name,
            p.proname AS function_name,
            p.proargtypes,
            p.proconfig,
            p.oid::regprocedure AS signature
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'private')
          AND p.prokind = 'f'
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM unnest(COALESCE(v_function.proconfig, ARRAY[]::TEXT[])) AS config(value)
            WHERE config.value LIKE 'search_path=%'
        ) THEN
            RAISE EXCEPTION 'Application function % must pin search_path', v_function.signature;
        END IF;

        IF has_function_privilege('anon', v_function.oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'Anonymous role must not execute application function %', v_function.signature;
        END IF;

        v_is_authenticated_helper := (
            v_function.schema_name = 'private'
            AND (
                (
                    v_function.function_name IN (
                        'can_read_staff_profile',
                        'is_staff_in_studio',
                        'is_admin_or_front_desk_in_studio',
                        'is_admin_in_studio'
                    )
                    AND pg_catalog.oidvectortypes(v_function.proargtypes) = 'uuid'
                )
                OR (
                    v_function.function_name = 'has_unambiguous_studio_membership'
                    AND pg_catalog.oidvectortypes(v_function.proargtypes) = ''
                )
            )
        );

        IF v_is_authenticated_helper THEN
            IF NOT has_function_privilege('authenticated', v_function.oid, 'EXECUTE') THEN
                RAISE EXCEPTION 'Authenticated RLS helper % must remain executable', v_function.signature;
            END IF;
        ELSIF has_function_privilege('authenticated', v_function.oid, 'EXECUTE') THEN
            RAISE EXCEPTION 'Authenticated role must not execute application function %', v_function.signature;
        END IF;
    END LOOP;

    IF to_regprocedure('public.set_student_is_minor()') IS NOT NULL
       AND NOT EXISTS (
        SELECT 1
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL unnest(COALESCE(p.proconfig, ARRAY[]::TEXT[])) AS config(value)
        WHERE n.nspname = 'public'
          AND p.proname = 'set_student_is_minor'
          AND pg_get_function_identity_arguments(p.oid) = ''
          AND config.value = 'search_path=pg_catalog'
    ) THEN
        RAISE EXCEPTION 'set_student_is_minor must pin search_path to pg_catalog';
    END IF;

    EXECUTE format($canary_create$
        CREATE FUNCTION pg_temp.%I()
        RETURNS void
        LANGUAGE plpgsql
        SECURITY INVOKER
        SET search_path = pg_catalog
        AS $canary_body$
        BEGIN
            RETURN;
        END
        $canary_body$
    $canary_create$, v_canary_name);
    SELECT nspname
    INTO v_canary_schema
    FROM pg_namespace
    WHERE oid = pg_my_temp_schema();
    SELECT p.oid
    INTO v_canary_oid
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = v_canary_schema
      AND p.proname = v_canary_name
      AND pg_get_function_identity_arguments(p.oid) = '';
    IF NOT has_schema_privilege('anon', v_canary_schema, 'USAGE')
       OR NOT has_schema_privilege('authenticated', v_canary_schema, 'USAGE') THEN
        EXECUTE format(
            'GRANT USAGE ON SCHEMA %I TO anon, authenticated',
            v_canary_schema
        );
    END IF;
    EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION %I.%I() FROM PUBLIC, anon, authenticated',
        v_canary_schema, v_canary_name
    );
    IF NOT has_schema_privilege('anon', v_canary_schema, 'USAGE')
       OR NOT has_schema_privilege('authenticated', v_canary_schema, 'USAGE')
       OR has_function_privilege('public', v_canary_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_canary_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_canary_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'Authorization canary boundary is not schema-usable with function EXECUTE revoked.';
    END IF;
    RAISE NOTICE 'authorization_canary boundary schema=% schema_usage=anon,authenticated function_execute=none', v_canary_schema;

    SET LOCAL ROLE anon;
    v_denied := false;
    BEGIN
        EXECUTE format('SELECT %I.%I()', v_canary_schema, v_canary_name);
    EXCEPTION WHEN SQLSTATE '42501' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'anon authorization canary invocation was not denied with SQLSTATE 42501.';
    END IF;
    SELECT 1 INTO v_liveness;
    IF v_liveness <> 1 THEN
        RAISE EXCEPTION 'anon authorization canary session liveness check failed.';
    END IF;
    RAISE NOTICE 'authorization_canary role=anon sqlstate=42501 same_session_liveness=%', v_liveness;

    SET LOCAL ROLE authenticated;
    v_denied := false;
    BEGIN
        EXECUTE format('SELECT %I.%I()', v_canary_schema, v_canary_name);
    EXCEPTION WHEN SQLSTATE '42501' THEN
        v_denied := true;
    END;
    IF NOT v_denied THEN
        RAISE EXCEPTION 'authenticated authorization canary invocation was not denied with SQLSTATE 42501.';
    END IF;
    SELECT 1 INTO v_liveness;
    IF v_liveness <> 1 THEN
        RAISE EXCEPTION 'authenticated authorization canary session liveness check failed.';
    END IF;
    RAISE NOTICE 'authorization_canary role=authenticated sqlstate=42501 same_session_liveness=%', v_liveness;

    EXECUTE format('SET LOCAL ROLE %I', v_original_role);
    EXECUTE format('DROP FUNCTION %I.%I()', v_canary_schema, v_canary_name);
END
$$;
