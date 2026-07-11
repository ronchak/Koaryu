DO $$
DECLARE
    v_function RECORD;
    v_is_authenticated_helper BOOLEAN;
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
            AND v_function.function_name IN (
                'is_staff_in_studio',
                'is_admin_or_front_desk_in_studio',
                'is_admin_in_studio'
            )
            AND pg_catalog.oidvectortypes(v_function.proargtypes) = 'uuid'
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
END
$$;
